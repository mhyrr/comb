import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { displayName, fileTime, McpHealth, outcomeOf, readMcpHealth, reasonOf, serverKey, type HealthReport } from "../mcphealth";
import { readAgentLanes, sessionOwner } from "../timeline";
import { countTools, mcpServerOf } from "../tools";
import { defaultRoots, UsageIndex, type ToolRec } from "../usage";
import { tileLine, toolsHtml } from "../page/ui/tools";

const NOW = Date.parse("2026-11-20T22:00:00Z");
const ago = (min: number) => NOW - min * 60_000;
const line = (o: object) => JSON.stringify(o);

// The error lines below are copied from real Claude Code MCP logs on 2026-11-20
// (github, a local notes server and a claude.ai server), so the parser is held
// to the format Claude Code actually writes.
const REAL = {
  github400: [
    line({ debug: "initialize POST rejected (Error POSTing to endpoint: bad request: Authorization header is badly formatted ); trying legacy HTTP+SSE" }),
    line({ debug: "Connection failed after 442ms, 442ms of it awake (400): Error POSTing to endpoint: bad request: Authorization header is badly formatted " }),
    line({ error: "Connection failed (400): Error POSTing to endpoint: bad request: Authorization header is badly formatted " }),
  ],
  refused: [
    line({ error: "TypeError: ECONNREFUSED: Unable to connect. Is the computer able to access the url?\n    at async <anonymous> (/$bunfs/root/chunk.js:19:3633)" }),
    line({ error: "Connection failed (ECONNREFUSED): ECONNREFUSED: Unable to connect. Is the computer able to access the url?" }),
    line({ debug: "Transient ECONNREFUSED on initial connect — retry 1/3 in 901ms" }),
  ],
  gateway502: [
    line({ debug: "claude.ai proxy connection failed after 664ms: Error POSTing to endpoint: {\"type\":\"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-502/\"}" }),
    line({ error: "Connection failed (502): Error POSTing to endpoint: {\"type\":\"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-502/\",\"title\":\"Error 502: Bad gateway\",\"status\":502}" }),
  ],
  connected: [line({ debug: "Starting connection with timeout of 30000ms" }), line({ debug: "Successfully connected (transport: stdio) in 386ms" })],
  signin: [line({ debug: "HTTP Connection failed after 1788ms: Unauthorized (code: none, errno: none)" }), line({ error: "UnauthorizedError: Unauthorized" }), line({ debug: "Authentication required for HTTP server" })],
};

describe("MCP log parsing", () => {
  test("connected, 400, refused and 502, each to a short reason; the raw message never comes through", () => {
    expect(outcomeOf(REAL.connected.join("\n"))).toEqual({ ok: true });
    expect(outcomeOf(REAL.github400.join("\n"))).toEqual({ ok: false, code: "400", reason: "400 · bad Authorization header" });
    expect(outcomeOf(REAL.refused.join("\n"))).toEqual({ ok: false, code: "ECONNREFUSED", reason: "refused" });
    expect(outcomeOf(REAL.gateway502.join("\n"))).toEqual({ ok: false, code: "502", reason: "502 · bad gateway" });
    expect(JSON.stringify(outcomeOf(REAL.gateway502.join("\n")))).not.toContain("cloudflare");
  });

  test("a sign-in nobody gave is its own state; the last outcome in a file wins; a cut first line is skipped", () => {
    expect(outcomeOf(REAL.signin.join("\n"))).toEqual({ ok: false, signin: true });
    expect(outcomeOf([...REAL.refused, ...REAL.connected].join("\n"))).toEqual({ ok: true }); // a retry got through
    expect(outcomeOf(`ully connected (transport: stdio)"}\n${REAL.github400.at(-1)}`)).toMatchObject({ code: "400" });
    expect(outcomeOf(line({ debug: "Starting connection with timeout of 30000ms" }))).toBeNull();
  });

  test("reasons for other codes, names and keys", () => {
    expect([reasonOf("400", "bad request"), reasonOf("401", ""), reasonOf("503", ""), reasonOf("599", ""), reasonOf("ETIMEDOUT", ""), reasonOf("ENOTFOUND", "")])
      .toEqual(["400 · bad request", "401 · needs sign-in", "503 · unavailable", "599 · server error", "timed out", "host not found"]);
    expect([displayName("plugin-github-github"), displayName("claude-ai-Google-Drive"), displayName("reflect-notes")]).toEqual(["github", "Google Drive", "reflect-notes"]);
    expect(serverKey("plugin-github-github")).toBe(serverKey("plugin_github_github"));
    expect(serverKey("claude-ai-Dealsplit")).toBe(serverKey("claude_ai_Dealsplit"));
    expect([mcpServerOf("mcp__claude_ai_Google_Drive__search_files"), mcpServerOf("mcp__hive__search_memory"), mcpServerOf("Bash")])
      .toEqual(["claude_ai_google_drive", "hive", null]);
    expect(fileTime("2026-11-20T21-57-18-616Z.jsonl")).toBe(Date.parse("2026-11-20T21:57:18.616Z"));
    expect(fileTime("notes.txt")).toBeNaN();
  });
});

describe("reading the logs", () => {
  let root: string;
  const log = async (project: string, server: string, minAgo: number, lines: string[]) => {
    const dir = join(root, project, `mcp-logs-${server}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${new Date(ago(minAgo)).toISOString().replace(/[:.]/g, "-")}.jsonl`), lines.join("\n") + "\n");
  };
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "comb-mcplogs-"));
    await log("-p1", "hive", 30, REAL.connected);
    await log("-p1", "plugin-github-github", 60 * 50, REAL.connected); // fine two days ago
    await log("-p2", "plugin-github-github", 60 * 30, REAL.github400); // then failing, in another project
    await log("-p1", "plugin-github-github", 10, REAL.github400);
    await log("-p1", "reflect-notes", 10, REAL.refused);
    await log("-p1", "claude-ai-Dealsplit", 10, REAL.gateway502);
    await log("-p1", "plugin-stripe-stripe", 10, REAL.signin);
    await log("-p1", "old-server", 60 * 24 * 5, REAL.github400); // nothing recent: not reported
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  test("the newest log per server across projects, and how long a failure has run", async () => {
    const r = await readMcpHealth({ roots: [root], now: NOW });
    expect(r.note).toBeNull();
    const by = Object.fromEntries(r.servers.map((s) => [s.name, s]));
    expect(Object.keys(by).sort()).toEqual(["Dealsplit", "github", "hive", "reflect-notes", "stripe"]);
    expect(by.hive).toMatchObject({ state: "ok", reason: null });
    expect(by.github).toMatchObject({ state: "failing", reason: "400 · bad Authorization header", since: new Date(ago(60 * 30)).toISOString(), sinceAtLeast: false });
    expect(by["reflect-notes"]).toMatchObject({ state: "failing", reason: "refused" });
    expect(by.Dealsplit).toMatchObject({ state: "failing", reason: "502 · bad gateway", key: "claude_ai_dealsplit" });
    expect(by.stripe).toMatchObject({ state: "signin", reason: "needs sign-in" });
  });

  test("no logs at all: the panel says health is unknown, and still counts", async () => {
    expect(await readMcpHealth({ roots: [join(root, "nowhere")], now: NOW })).toEqual({ servers: [], note: "Health unknown: Claude Code's MCP logs were not found." });
    const empty = await mkdtemp(join(tmpdir(), "comb-mcplogs-empty-"));
    expect((await readMcpHealth({ roots: [empty], now: NOW })).note).toContain("not found");
    await rm(empty, { recursive: true, force: true });
  });

  test("a finished log's outcome is kept, so the next read only reads the newest", async () => {
    const h = new McpHealth({ roots: [root] });
    await h.read(NOW);
    // Rewrite the two-day-old good log as a failure: a cached reader does not see it.
    await log("-p1", "plugin-github-github", 60 * 50, REAL.github400);
    const again = (await h.read(NOW)).servers.find((s) => s.name === "github")!;
    expect(again.since).toBe(new Date(ago(60 * 30)).toISOString());
    const fresh = (await new McpHealth({ roots: [root] }).read(NOW)).servers.find((s) => s.name === "github")!;
    expect(fresh.since).toBe(new Date(ago(60 * 50)).toISOString());
  });
});

describe("counting the agents' tools", () => {
  const call = (id: string, session: string, minAgo: number, name: string, cli?: string): ToolRec => ({ id, ts: ago(minAgo), session, name, ...(cli ? { cli } : {}) });
  const health: HealthReport = {
    note: null,
    servers: [
      { key: "hive", name: "hive", state: "ok", reason: null, since: null, sinceAtLeast: false, checkedAt: new Date(ago(10)).toISOString() },
      { key: "plugin_github_github", name: "github", state: "failing", reason: "400 · bad Authorization header", since: new Date(ago(60 * 24 * 8)).toISOString(), sinceAtLeast: true, checkedAt: new Date(ago(10)).toISOString() },
      { key: "easel", name: "easel", state: "ok", reason: null, since: null, sinceAtLeast: false, checkedAt: new Date(ago(10)).toISOString() },
      { key: "plugin_stripe_stripe", name: "stripe", state: "signin", reason: "needs sign-in", since: null, sinceAtLeast: false, checkedAt: new Date(ago(10)).toISOString() },
    ],
  };
  const ownerOf = sessionOwner([{ name: "maya", sessions: ["aaaa0001"], current: null }, { name: "rl", sessions: [], current: "bbbb0002-full" }]);
  const calls = [
    call("t1", "aaaa0001-x", 30, "mcp__hive__search_memory"),
    call("t2", "bbbb0002-full", 20, "mcp__hive__show_ticket"),
    call("t3", "bbbb0002-full", 20, "Bash", "gh"),
    call("t4", "bbbb0002-full", 19, "Bash"),
    call("t5", "bbbb0002-full", 19, "Edit"),
    call("t6", "greg-own-session", 5, "mcp__playwright__browser_navigate"), // not a comb agent: not counted
    call("t7", "aaaa0001-x", 60 * 24 * 8, "mcp__hive__list_tickets"), // older than 7 days
  ];

  test("agents only, 7 days, gh by first word; a failing server shows though unused; idle and sign-in go to the footnote", () => {
    const r = countTools({ now: NOW, calls, ownerOf, health });
    expect(r.total).toBe(5);
    expect(r.tiles.map((t) => [t.name, t.kind, t.agents, t.calls, t.health?.state ?? null])).toEqual([
      ["hive", "mcp", 2, 2, "ok"],
      ["gh", "cli", 1, 1, null],
      ["github", "mcp", 0, 0, "failing"],
    ]);
    expect(r.builtins).toEqual([{ name: "Bash", calls: 2 }, { name: "Edit", calls: 1 }]);
    expect(r.idle).toEqual(["easel"]);
    expect(r.signin).toEqual(["stripe"]);
  });

  test("on the page: the failure in words with its date, use counts, the footnote, escaping", () => {
    const r = countTools({ now: NOW, calls, ownerOf, health });
    const c = { day: (ms: number) => new Date(ms).toISOString().slice(5, 10) };
    expect(tileLine(r.tiles[2]!, c)).toEqual({ text: `Not connecting · 400 · bad Authorization header · since at least ${new Date(ago(60 * 24 * 8)).toISOString().slice(5, 10)}`, bad: true });
    expect(tileLine(r.tiles[0]!, c)).toEqual({ text: "2 agents · 2 calls", bad: false });
    expect(tileLine(r.tiles[1]!, c).text).toBe("1 agent · 1 run");
    const html = toolsHtml({ ready: true, error: null, ...r }, c);
    expect(html).toContain('class="tool bad unused"');
    expect(html).toContain("Plus built-ins: Bash 2 · Edit 1.");
    expect(html).toContain("Connected, unused by agents: easel.");
    expect(html).toContain("1 more server waits for a sign-in nobody has given.");
    const missing = toolsHtml({ ready: true, error: null, ...countTools({ now: NOW, calls, ownerOf, health: { servers: [], note: "Health unknown: Claude Code's MCP logs were not found." } }) }, c);
    expect(missing).toContain("Health unknown: Claude Code's MCP logs were not found.");
    expect(toolsHtml({ ready: true, error: null, ...countTools({ now: NOW, calls, ownerOf, health: { ...health, servers: [{ ...health.servers[1]!, name: "<x>" }] } }) }, c)).toContain("&lt;x&gt;");
  });
});

describe("tools from the fixture world", () => {
  test("fixture agents' calls and fixture MCP logs, end to end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "comb-tools-"));
    const build = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../../scripts/fixture/build.ts"), dir]);
    expect(build.exitCode).toBe(0);
    const home = join(dir, "home");
    const ix = new UsageIndex({ roots: defaultRoots(home), cachePath: null });
    await ix.refresh();
    const r = countTools({
      now: Date.now(),
      calls: ix.toolCalls(),
      ownerOf: sessionOwner(await readAgentLanes(join(home, ".comb"))),
      health: await readMcpHealth({ roots: [join(home, "Library", "Caches", "claude-cli-nodejs")] }),
    });
    const tile = (n: string) => r.tiles.find((t) => t.name === n);
    expect(tile("comb")).toMatchObject({ kind: "mcp", health: { state: "ok" } });
    expect(tile("hive")?.health?.state).toBe("ok");
    expect(tile("playwright")).toMatchObject({ agents: 1, calls: 2 });
    expect(tile("gh")).toMatchObject({ kind: "cli", agents: 1, calls: 1 });
    expect(tile("github")).toMatchObject({ calls: 0, health: { state: "failing", reason: "400 · bad Authorization header" } });
    expect(tile("notes")?.health?.reason).toBe("refused");
    expect(tile("Billing")?.health?.reason).toBe("502 · bad gateway");
    expect(r.idle).toEqual(["easel"]);
    expect(r.signin).toEqual(["slack"]);
    // The user's own session (web-app-3f) used Grep; it is not an agent, so it is not counted.
    expect(r.builtins.map((b) => b.name)).not.toContain("Grep");
    await rm(dir, { recursive: true, force: true });
  });
});
