#!/usr/bin/env bun
/**
 * Builds an invented comb world for screenshots: a fake HOME with ~/.comb
 * (agents, queue, reports), Claude Code transcripts, a hive project registry,
 * a roster for the fake `claude`, and tickets and memory for the fake hive MCP
 * server. Every agent, project, ticket and line of text here is made up.
 *
 *   bun scripts/fixture/build.ts <dir>      build (replaces <dir>)
 *   bun scripts/fixture/serve.ts <dir>      serve the page against it
 *
 * Times are relative to now, so "2m ago" reads right whenever it is built.
 */
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const out = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: bun scripts/fixture/build.ts <dir>");
  process.exit(2);
}
rmSync(out, { recursive: true, force: true });

const HOME = join(out, "home");
// Repos live under the fake HOME, so the page shows them as ~/work/<project>.
const REPOS = join(HOME, "work");
const COMB = join(HOME, ".comb");
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const day = (min: number) => ago(min).slice(0, 10);

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// --- projects ---------------------------------------------------------------
const PROJECTS = ["acme-api", "docs-site", "web-app"];
for (const p of PROJECTS) {
  mkdirSync(join(REPOS, p), { recursive: true });
  put(join(HOME, ".hive", "projects", p, "config.md"), `---\nname: ${p}\npath: ${join(REPOS, p)}\n---\n`);
}

// --- transcripts --------------------------------------------------------------
type Line = Record<string, unknown>;
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const user = (min: number, content: string): Line => ({ type: "user", timestamp: ago(min), uuid: uuid(), message: { role: "user", content } });
const say = (min: number, text: string): Line => ({ type: "assistant", timestamp: ago(min), uuid: uuid(), message: { role: "assistant", content: [{ type: "text", text }] } });
const tool = (min: number, id: string, name: string, input: Record<string, unknown>): Line =>
  ({ type: "assistant", timestamp: ago(min), uuid: uuid(), message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const result = (min: number, id: string, isError = false): Line =>
  ({ type: "user", timestamp: ago(min), uuid: uuid(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: isError }] } });
const idle = (min: number, ms: number): Line => ({ type: "system", subtype: "turn_duration", timestamp: ago(min), uuid: uuid(), durationMs: ms });
const from = (name: string, text: string) => `Message from ${name}. Reply with the comb agent_send tool to "${name}".\n\n${text}`;
const peer = (name: string, text: string) => `<cross-session-message from-name="${name}">\n${text}\n</cross-session-message>`;

function transcript(cwd: string, sessionId: string, lines: Line[]) {
  const path = join(HOME, ".claude", "projects", cwd.replace(/[/.]/g, "-"), `${sessionId}.jsonl`);
  // Real tool-use ids are unique (toolu_…); the short ones above repeat across sessions, so make them unique here.
  const tid = (id: unknown) => `toolu_${sessionId.slice(0, 8)}_${String(id)}`;
  const fix = (l: Line): Line => {
    const m = l.message as { content?: unknown } | undefined;
    if (!Array.isArray(m?.content)) return l;
    return { ...l, message: { ...m, content: m.content.map((b: Record<string, unknown>) =>
      b.type === "tool_use" ? { ...b, id: tid(b.id) } : b.type === "tool_result" ? { ...b, tool_use_id: tid(b.tool_use_id) } : b) } };
  };
  put(path, lines.map((l) => JSON.stringify({ cwd, sessionId, ...fix(l) })).join("\n") + "\n");
}

// --- agents -------------------------------------------------------------------
type Agent = {
  name: string; parent: string; project: string | null; cwd: string; worktree: boolean;
  sessionId: string; charter: string; log: string[]; reports?: Record<string, string>; startedMin: number;
};

function agent(a: Agent) {
  const dir = join(COMB, "agents", a.name);
  put(join(dir, "charter.md"), a.charter.trim() + "\n");
  put(join(dir, "checklist.md"), "# Checklist\n\nEach time you wake:\n\n1. Read what arrived and act on it.\n2. Move the next thing forward.\n3. Append to log.md what you did and why.\n");
  put(join(dir, "log.md"), `# Log: ${a.name}\n\n${a.log.join("\n")}\n`);
  mkdirSync(join(dir, "memory"), { recursive: true });
  mkdirSync(join(dir, "reports"), { recursive: true });
  for (const [file, text] of Object.entries(a.reports ?? {})) put(join(dir, "reports", file), text.trim() + "\n");
  put(join(dir, "session.json"), JSON.stringify({
    name: a.name, harness: "claude", id: a.sessionId.slice(0, 8), sessionId: a.sessionId, parent: a.parent,
    project: a.project, cwd: a.cwd, worktree: a.worktree, permissionMode: "auto", model: a.name === "maya" ? "opus" : null,
    startedAt: ago(a.startedMin),
  }, null, 2) + "\n");
  mkdirSync(a.cwd, { recursive: true });
  return dir;
}

const wt = (p: string, name: string) => join(REPOS, p, ".claude", "worktrees", name);

// Maya, the chief of staff.
const maya = { name: "maya", sessionId: "a1b2c3d4-0000-4000-8000-000000000001", cwd: REPOS };
agent({
  ...maya, parent: "greg", project: null, worktree: false, startedMin: 60 * 26,
  charter: `# Maya, chief of staff (background)

Keep the work moving so it does not wait on one person. Push every piece as
far as it can go, and bring forward only the decisions that need a human, each
with a recommendation.

- One task agent per job, started with \`agent_start\`.
- Follow-ups go to the agent already doing the job.
- Look across: collisions, duplicated work, shared blockers.`,
  log: [
    `- ${ago(60 * 26)} started by greg in ${REPOS} (session ${maya.sessionId.slice(0, 8)}, model opus)`,
    `- ${ago(95)} started acme-api-tk42-rate-limits on TK-42, because the design was agreed yesterday`,
    `- ${ago(40)} filed a decision on the rate-limit store; it changes ops, so it is not mine to make`,
    `- ${ago(12)} answered what is waiting: two reviews and one decision`,
  ],
});
transcript(maya.cwd, maya.sessionId, [
  user(60 * 20, "Morning sweep: what moved overnight, and what is next?"),
  tool(60 * 20 - 1, "m0", "mcp__hive__list_tickets", { project: "acme-api" }),
  result(60 * 20 - 1, "m0"),
  say(60 * 20 - 6, "Nothing moved overnight. TK-42's design is agreed; I'll start it once the load-test numbers are in."),
  idle(60 * 20 - 6, 6 * 60_000),
  user(60 * 5 + 2, peer("greg", "Start the docs search too; it is small.")),
  tool(60 * 5, "m00", "mcp__comb__agent_start", { name: "docs-site-search", charter: "Client-side search …" }),
  result(60 * 5, "m00"),
  say(60 * 5 - 1, "Started **docs-site-search**."),
  idle(60 * 5 - 1, 3 * 60_000),
  user(95, from("greg", "TK-42 is agreed. Get it built.")),
  tool(94, "m1", "mcp__hive__show_ticket", { project: "acme-api", id: "TK-42" }),
  result(94, "m1"),
  tool(93, "m2", "mcp__comb__agent_start", { name: "acme-api-tk42-rate-limits", charter: "Build TK-42 …" }),
  result(93, "m2"),
  say(92, "Started **acme-api-tk42-rate-limits** on its own worktree. Its charter has the ticket, the agreed design, and where the load-test numbers are."),
  idle(92, 61_000),
  user(41, peer("acme-api-tk42-rate-limits", "Two ways to store the counters: Postgres advisory locks (no new service) or Redis (faster, one more thing to run). I lean Postgres. Your call or the user's?")),
  tool(40, "m3", "mcp__comb__queue_add", { kind: "decision", title: "Rate-limit counters: Postgres or Redis" }),
  result(40, "m3"),
  say(40, "That one changes what ops has to run, so I filed it as a decision with both options and my pick (Postgres)."),
  idle(40, 22_000),
  user(13, "The user, on the comb page:\n(The user reads your answer on the page. Answer in your reply; do not use agent_send for it.)\n\nwhat's waiting on me?"),
  tool(13, "m4", "mcp__comb__agent_list", {}),
  result(13, "m4"),
  tool(12, "m5", "Read", { file_path: join(COMB, "agents", "docs-site-search", "reports", `${day(180)}-search-index.md`) }),
  result(12, "m5"),
  say(12, `Three things, in this order:

1. **Rate-limit counters: Postgres or Redis** (decision). I recommend Postgres: no new service, and the load test shows 4× headroom.
2. **Review: docs-site search** (review). The branch is green and I checked the preview build. It is ready to merge.
3. **Start acme-api TK-51** (proposal). Key rotation is next in line once TK-42 lands.

Everything else is moving. TK-42 is in tests now.`),
  idle(12, 48_000),
]);

// A task agent, working now, on its own worktree.
const rl = { name: "acme-api-tk42-rate-limits", sessionId: "b2c3d4e5-0000-4000-8000-000000000002", cwd: wt("acme-api", "acme-api-tk42-rate-limits") };
agent({
  ...rl, parent: "maya", project: "acme-api", worktree: true, startedMin: 93,
  charter: `# acme-api TK-42: per-key rate limits

Done means: every API key has a requests-per-minute limit, over-limit calls
get 429 with Retry-After, and the load test passes at 2× today's peak.

- Ticket: acme-api TK-42. Design: docs/rate-limits.md.
- Work on your own worktree. Start a reviewer child when the branch is green.`,
  log: [
    `- ${ago(93)} started by maya in ${rl.cwd}`,
    `- ${ago(70)} decided: sliding window, not fixed buckets, because fixed buckets let a burst through at the boundary`,
    `- ${ago(42)} asked maya about the counter store; building against an interface meanwhile`,
    `- ${ago(9)} started acme-api-tk42-review on the branch`,
  ],
});
transcript(rl.cwd, rl.sessionId, [
  user(93, "Read your charter.md and checklist.md, then begin."),
  tool(92, "r1", "Read", { file_path: join(rl.cwd, "docs", "rate-limits.md") }),
  result(92, "r1"),
  tool(90, "r2", "Grep", { pattern: "authenticateKey" }),
  result(90, "r2"),
  say(88, "The middleware chain already resolves the key before routing, so the limiter can sit right after `authenticateKey`. Sliding window per key, counters behind a small `CounterStore` interface until the store is decided."),
  tool(80, "r3", "Write", { file_path: join(rl.cwd, "src", "middleware", "rate-limit.ts") }),
  result(80, "r3"),
  tool(74, "r4", "Write", { file_path: join(rl.cwd, "src", "middleware", "rate-limit.test.ts") }),
  result(74, "r4"),
  tool(72, "r5", "Bash", { description: "Run the rate-limit tests" }),
  result(72, "r5", true),
  say(71, "One failure: `Retry-After` was in milliseconds. The header is seconds. Fixed."),
  tool(70, "r6", "Edit", { file_path: join(rl.cwd, "src", "middleware", "rate-limit.ts") }),
  result(70, "r6"),
  tool(69, "r7", "Bash", { description: "Run the rate-limit tests" }),
  result(69, "r7"),
  tool(42, "r8", "mcp__comb__agent_send", { to: "maya", message: "Counter store: Postgres or Redis?" }),
  result(42, "r8"),
  idle(42, 51 * 60_000),
  user(11, peer("maya", "Build against the interface; the store is with the user.")),
  tool(10, "r9", "mcp__comb__agent_start", { name: "acme-api-tk42-review" }),
  result(10, "r9"),
  say(4, "Reviewer started. While it reads, I'm running the load test at 2× peak against the Postgres store."),
  tool(2, "r10", "Bash", { description: "Load test: 2x peak for 5 minutes" }),
]);

// Its reviewer child, waiting for the next message.
const rv = { name: "acme-api-tk42-review", sessionId: "c3d4e5f6-0000-4000-8000-000000000003", cwd: wt("acme-api", "acme-api-tk42-review") };
agent({
  ...rv, parent: "acme-api-tk42-rate-limits", project: "acme-api", worktree: true, startedMin: 10,
  charter: "# Review: acme-api TK-42 branch\n\nReview `worktree-acme-api-tk42-rate-limits` for correctness and for the 429 contract. Report findings to your parent.",
  log: [`- ${ago(10)} started by acme-api-tk42-rate-limits in ${rv.cwd}`, `- ${ago(5)} sent two findings to the parent`],
});
transcript(rv.cwd, rv.sessionId, [
  user(10, "Read your charter.md and checklist.md, then begin."),
  tool(9, "v1", "Bash", { command: "gh pr diff 41", description: "Diff the branch against main" }),
  result(9, "v1"),
  tool(8, "v2", "Read", { file_path: join(rv.cwd, "src", "middleware", "rate-limit.ts") }),
  result(8, "v2"),
  tool(7, "v4", "mcp__playwright__browser_navigate", { url: "http://localhost:4000/keys" }),
  result(7, "v4"),
  tool(7, "v5", "mcp__playwright__browser_take_screenshot", {}),
  result(8, "v2"),
  say(6, "Two findings:\n\n1. The window key uses the raw API key. Use its id, so keys never land in the counter table.\n2. A 429 has no `X-RateLimit-Remaining`. The design doc promises it."),
  tool(5, "v3", "mcp__comb__agent_send", { to: "acme-api-tk42-rate-limits", message: "Two findings…" }),
  result(5, "v3"),
  idle(5, 290_000),
]);

// Finished today, with a report: asleep, still in the tree.
const ds = { name: "docs-site-search", sessionId: "d4e5f6a7-0000-4000-8000-000000000004", cwd: wt("docs-site", "docs-site-search") };
const dsDir = agent({
  ...ds, parent: "maya", project: "docs-site", worktree: true, startedMin: 60 * 5,
  charter: "# docs-site TK-12: client-side search\n\nDone means: a search box that finds any page by title or heading, under 50 KB added to the bundle, with no server.",
  log: [`- ${ago(300)} started by maya in ${ds.cwd}`, `- ${ago(240)} decided: build the index at build time, because the docs change only on deploy`, `- ${ago(180)} wrote the report and told maya`],
  reports: {
    [`${day(180)}-search-index.md`]: `# docs-site search: built and verified

Search is on branch \`worktree-docs-site-search\`, ready for review.

## What I did

- A build step writes \`search-index.json\` from every page's title and headings (412 pages, 38 KB gzipped).
- The search box loads the index on first focus, so page loads are unchanged.
- Results rank title matches above heading matches.

## Decisions

- Built the index at build time, not at runtime: the docs change only on deploy.
- No fuzzy matching yet. Prefix matching covered all 30 queries from the support log.

## Verified

- Unit tests for the index builder and the ranker pass.
- In the preview build, the 30 support-log queries each find the right page in the top three.

## Left

- Fuzzy matching, if users ask for it.`,
  },
});
transcript(ds.cwd, ds.sessionId, [
  user(300, "Read your charter.md and checklist.md, then begin."),
  say(182, "Done. The report is in reports/, and the branch is ready for review."),
  tool(181, "d1", "mcp__comb__agent_send", { to: "maya", message: "docs-site search is done." }),
  result(181, "d1"),
  idle(180, 120 * 60_000),
]);
// The report was written when the work finished, not when this fixture was built.
const dsDone = new Date(now - 183 * 60_000);
utimesSync(join(dsDir, "reports", `${day(180)}-search-index.md`), dsDone, dsDone);

// Finished over a week ago: folds into the Finished group.
const wb = { name: "web-app-bundle-size", sessionId: "e5f6a7b8-0000-4000-8000-000000000005", cwd: wt("web-app", "web-app-bundle-size") };
const wbDir = agent({
  ...wb, parent: "maya", project: "web-app", worktree: true, startedMin: 60 * 24 * 10,
  charter: "# web-app: cut the bundle under 200 KB\n\nFind what is heavy and remove it without changing behavior.",
  log: [`- ${ago(60 * 24 * 10)} started by maya in ${wb.cwd}`, `- ${ago(60 * 24 * 9)} wrote the report and told maya`],
  reports: {
    [`${day(60 * 24 * 9)}-bundle-size.md`]: "# web-app bundle: 312 KB to 188 KB\n\nReplaced the date library with `Intl`, and lazy-loaded the chart view.",
  },
});
transcript(wb.cwd, wb.sessionId, [
  user(60 * 24 * 10, "Read your charter.md and checklist.md, then begin."),
  say(60 * 24 * 9, "Bundle is 188 KB. Report written."),
  idle(60 * 24 * 9, 12_000),
]);
const old = new Date(now - 9 * 24 * 3600_000);
utimesSync(join(wbDir, "log.md"), old, old);
utimesSync(join(wbDir, "reports", `${day(60 * 24 * 9)}-bundle-size.md`), old, old);

// One of the user's own interactive sessions.
const mine = { name: "web-app-3f", sessionId: "f6a7b8c9-0000-4000-8000-000000000006", cwd: join(REPOS, "web-app") };
transcript(mine.cwd, mine.sessionId, [
  user(60 * 13, "what is left on the web-app settings page?"),
  idle(60 * 12, 55 * 60_000),
  user(60 * 9 + 30, "write the test for the settings route"),
  idle(60 * 7, 140 * 60_000),
  user(30, "the settings page flashes unstyled on first load. find out why"),
  tool(29, "w1", "Grep", { pattern: "settings.css" }),
  result(29, "w1"),
  say(27, "The settings route imports its CSS inside a lazy chunk, so the HTML renders before the stylesheet arrives. Moving the import into the route's layout fixes it; I've made that change and the flash is gone in the preview."),
  idle(27, 140_000),
]);

// --- Claude Code's MCP connect logs, one file per server per session start (src/mcphealth.ts) ---
// Invented servers beside the real ones: "notes" and "billing" stand in for a local and a claude.ai server.
const mcpLog = (server: string, minAgo: number, lines: Record<string, string>[]) => {
  const at = ago(minAgo);
  const file = `${at.replace(/[:.]/g, "-")}.jsonl`;
  put(join(HOME, "Library", "Caches", "claude-cli-nodejs", REPOS.replace(/[/.]/g, "-"), `mcp-logs-${server}`, file),
    lines.map((l) => JSON.stringify({ ...l, timestamp: at, sessionId: maya.sessionId, cwd: REPOS })).join("\n") + "\n");
};
const connected = [{ debug: "Starting connection with timeout of 30000ms" }, { debug: "Successfully connected (transport: stdio) in 180ms" }];
for (const server of ["hive", "comb", "playwright", "easel"]) mcpLog(server, 20, connected);
mcpLog("plugin-github-github", 60 * 72, connected); // fine three days ago
for (const m of [60 * 48, 60 * 20, 20]) {
  mcpLog("plugin-github-github", m, [
    { debug: "HTTP Connection failed after 441ms: Error POSTing to endpoint: bad request: Authorization header is badly formatted" },
    { error: "Connection failed (400): Error POSTing to endpoint: bad request: Authorization header is badly formatted" },
  ]);
}
mcpLog("notes", 20, [
  { error: "Connection failed (ECONNREFUSED): ECONNREFUSED: Unable to connect. Is the computer able to access the url?" },
  { debug: "Transient ECONNREFUSED on initial connect — retry 1/3 in 901ms" },
]);
mcpLog("claude-ai-Billing", 20, [{ error: "Connection failed (502): Error POSTing to endpoint: {\"title\":\"Error 502: Bad gateway\"}" }]);
mcpLog("plugin-marketing-slack", 20, [{ debug: "HTTP Connection failed after 758ms: Unauthorized" }, { debug: "Authentication required for HTTP server" }]);

// --- the roster the fake `claude agents --json` prints -------------------------
put(join(HOME, "live.json"), JSON.stringify([
  { id: maya.sessionId.slice(0, 8), sessionId: maya.sessionId, name: "maya", cwd: maya.cwd, kind: "background", state: "blocked", status: "idle", pid: 41001 },
  { id: rl.sessionId.slice(0, 8), sessionId: rl.sessionId, name: rl.name, cwd: rl.cwd, kind: "background", state: "working", status: "busy", pid: 41002 },
  { id: rv.sessionId.slice(0, 8), sessionId: rv.sessionId, name: rv.name, cwd: rv.cwd, kind: "background", state: "blocked", status: "idle", pid: 41003 },
  { id: mine.sessionId.slice(0, 8), sessionId: mine.sessionId, name: mine.name, cwd: mine.cwd, kind: "interactive", status: "idle", pid: 41004 },
], null, 2) + "\n");

// --- the queue -----------------------------------------------------------------
function item(id: string, f: { kind: string; from: string; title: string; action: string; project: string; ticket: string; created: string; model?: string; modelWhy?: string; onNo?: string; onRedirect?: string }, body: string) {
  const head = Object.entries({ id, ...f, status: "open", answered: "", note: "" }).map(([k, v]) => `${k}: ${v}`).join("\n");
  put(join(COMB, "queue", id, "item.md"), `---\n${head}\n---\n\n${body.trim()}\n`);
}
item(`${day(40)}-rate-limit-counters-postgres-or-redis`, {
  kind: "decision", from: "maya", title: "Rate-limit counters: Postgres or Redis", project: "acme-api", ticket: "TK-42", created: ago(40),
  action: "I tell acme-api-tk42-rate-limits to ship the store you pick.",
  onRedirect: "Say Redis and it ships Redis instead.",
}, `**Recommendation: Postgres.** No new service to run, and the load test shows 4× headroom at today's peak.

| | Postgres advisory locks | Redis |
|---|---|---|
| New service | No | Yes |
| p99 added per call | 1.8 ms | 0.4 ms |
| Ops cost | none | one more thing to page on |

Redis wins only if traffic grows past 10× this year.`);
item(`${day(180)}-review-docs-site-search`, {
  kind: "review", from: "docs-site-search", title: "Review: docs-site client-side search", project: "docs-site", ticket: "TK-12", created: ago(180),
  action: "I mark TK-12 done and hand the branch to you to merge.",
  onNo: "The branch stays open and I stop here; nothing merges.",
}, "Branch `worktree-docs-site-search` is green. 412 pages indexed, 38 KB gzipped. All 30 support-log queries find the right page in the top three. Report: `reports/` in my workspace.");
item(`${day(8)}-start-acme-api-tk-51-rotate-api-keys`, {
  kind: "proposal", from: "maya", title: "Start acme-api TK-51: rotate API keys", project: "acme-api", ticket: "TK-51", created: ago(8),
  action: "I start task agent acme-api-tk51 on acme-api TK-51.",
  model: "sonnet", modelWhy: "The design is settled; this is careful plumbing, not judgment.",
},"Next in line once TK-42 lands, and it touches the same middleware, so the context is fresh now. The ticket has an agreed design.");

// --- tickets and memory for the fake hive MCP server ----------------------------
put(join(HOME, "hive-fixture.json"), JSON.stringify({
  tickets: {
    "acme-api": [
      { id: "TK-42", status: "in_progress", priority: 1, type: "feature", title: "Per-key rate limits", tags: ["api"], body: "Every key gets a requests-per-minute limit. Over-limit calls get 429 with Retry-After." },
      { id: "TK-51", status: "open", priority: 1, type: "feature", title: "Rotate API keys without downtime", tags: ["security"], body: "Two live keys per client during a rotation window." },
      { id: "TK-38", status: "open", priority: 2, type: "bug", title: "Pagination cursor breaks on deleted rows", body: "A cursor that points at a deleted row returns an empty page." },
    ],
    "docs-site": [
      { id: "TK-12", status: "in_progress", priority: 1, type: "feature", title: "Client-side search", body: "Search by title and heading, no server." },
      { id: "TK-15", status: "open", priority: 3, type: "chore", title: "Redirects for the old /guide URLs", body: "" },
    ],
    "web-app": [
      { id: "TK-7", status: "open", priority: 0, type: "bug", title: "Settings page flashes unstyled on first load", tags: ["ui"], body: "The stylesheet arrives after first paint." },
      { id: "TK-9", status: "open", priority: 2, type: "feature", title: "Dark mode for the chart view", body: "" },
    ],
  },
  memory: {
    "acme-api": [
      "## Durable facts",
      `- [${day(60 * 24 * 20)}] Requests authenticate in \`authenticateKey\` before routing; middleware after it can trust \`req.key\`. [auth, middleware]`,
      `- [${day(60 * 24 * 6)}] Peak traffic is about 1,900 requests a second, weekdays at 14:00 UTC. [traffic]`,
      "## Conventions",
      `- [${day(60 * 24 * 30)}] Every endpoint change ships with a contract test in \`test/contract/\`. [testing]`,
      "## Decisions",
      `- [${day(60 * 24 * 2)}] Rate limits use a sliding window per key, not fixed buckets. [rate-limits]`,
      "## Open questions",
      `- [${day(60 * 24)}] Do internal service keys get a limit, or a separate, higher tier? [rate-limits]`,
    ].join("\n"),
    "docs-site": "## Durable facts\n- The site builds with a static generator; every deploy rebuilds every page. [build]\n",
    "web-app": "## Conventions\n- Route CSS lives in the route's layout, never in a lazy chunk. [css]\n",
  },
}, null, 2) + "\n");

// --- usage (the Now tab's usage panel) ------------------------------------------
// Invented token counts: 30 days of Claude Code calls, a Codex session, an
// unused Gemini CLI and an installed Cursor. A fixed seed keeps the bars the
// same on every build.
{
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const models = ["claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5", "claude-fable-5-2", "claude-sonnet-5-5", "claude-haiku-5-5"];
  const lines: string[] = [];
  let id = 0;
  for (let d = 29; d >= 0; d--) {
    const weekend = new Date(now - d * 86400_000).getDay() % 6 === 0;
    const calls = Math.round((weekend ? 20 : 70) * (0.5 + rand()));
    for (let c = 0; c < calls; c++) {
      const min = d * 1440 + Math.floor(rand() * (d === 0 ? 600 : 1400));
      const session = `fixture-usage-${d}-${c % 6}`;
      lines.push(JSON.stringify({
        type: "assistant", sessionId: session, timestamp: ago(min), cwd: REPOS,
        message: {
          id: `msg_fixture_${++id}`, role: "assistant", model: models[Math.floor(rand() * models.length)], content: [{ type: "text", text: "Done." }],
          usage: {
            input_tokens: Math.round(rand() * 40), cache_creation_input_tokens: Math.round(rand() * 9000),
            cache_read_input_tokens: Math.round(60_000 + rand() * 120_000), output_tokens: Math.round(200 + rand() * 1800),
            output_tokens_details: { thinking_tokens: Math.round(rand() * 400) }, cache_creation: { ephemeral_1h_input_tokens: 0 },
          },
        },
      }));
    }
  }
  put(join(HOME, ".claude", "projects", "-fixture-usage", "usage.jsonl"), lines.join("\n") + "\n");

  const codex = (min: number, input: number, cached: number, output: number) => JSON.stringify({
    timestamp: ago(min), type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output } } },
  });
  put(join(HOME, ".codex", "sessions", day(60 * 24 * 3).replaceAll("-", "/"), "rollout-fixture.jsonl"), [
    JSON.stringify({ timestamp: ago(60 * 24 * 3), type: "session_meta", payload: { id: "codex-fixture" } }),
    JSON.stringify({ timestamp: ago(60 * 24 * 3), type: "turn_context", payload: { model: "gpt-6.1-sol" } }),
    codex(60 * 24 * 3 - 1, 40_000, 31_000, 9_000),
    codex(60 * 24 * 3 - 9, 410_000, 352_000, 61_000),
  ].join("\n") + "\n");

  const geminiDay = new Date(now - 70 * 86400_000);
  const gemini = join(HOME, ".gemini", "tmp", "docs-site", "chats", "session-fixture.json");
  put(gemini, JSON.stringify({
    sessionId: "gemini-fixture",
    messages: [{ id: "g1", type: "gemini", timestamp: geminiDay.toISOString(), model: "gemini-3-flash-preview", tokens: { input: 7000, output: 400, cached: 5000, thoughts: 60, total: 7460 } }],
  }));
  utimesSync(gemini, geminiDay, geminiDay);
  put(join(HOME, ".cursor", "argv.json"), "{}\n");
  // Plan limits, as comb's status-line tee saves Claude Code's rate_limits (src/statusline.ts),
  // with the tee installed in the fixture's Claude settings so the page shows no warning.
  put(join(COMB, "cache", "rate-limits.json"), JSON.stringify({
    at: ago(2),
    rate_limits: {
      five_hour: { used_percentage: 38, resets_at: Math.floor(now / 1000) + 3 * 3600 + 20 * 60 },
      seven_day: { used_percentage: 61, resets_at: Math.floor(now / 1000) + 4 * 86400 + 2 * 3600 },
    },
  }) + "\n");
  put(join(HOME, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "comb statusline" } }, null, 2) + "\n");
}

console.log(`fixture built at ${out}\n  HOME=${HOME}`);
