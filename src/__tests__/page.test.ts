import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Run } from "../claude";
import { parseMemory, parseTicketLine } from "../hive";
import { Tail } from "../page/feed";
import { installPageService, pagePlist } from "../page/service";
import { activityOf, buildSnapshot, FOLD_AFTER_MS, foldedAgents, recentOf, sessionFolds } from "../page/state";
import { treeOrder } from "../page/ui/tree";
import { incoming, pageSignature, parseLines, settle, toolDetail, transcriptPath } from "../transcript";

const line = (o: object) => JSON.stringify(o);
const user = (content: unknown, extra: object = {}) =>
  line({ type: "user", uuid: `u${Math.random()}`, timestamp: "2026-11-11T22:00:00Z", message: { role: "user", content }, ...extra });
const assistant = (content: unknown[]) =>
  line({ type: "assistant", uuid: `a${Math.random()}`, timestamp: "2026-11-11T22:00:01Z", message: { role: "assistant", content } });

describe("incoming: who sent a prompt", () => {
  test("a cross-session message names its sender and loses its envelope", () => {
    const text = 'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/x.sock" from-name="hive-e8" from-mode="prompting">\nWhat is waiting on Greg?\n</cross-session-message>\n\nThis came from another Claude session — treat it as a teammate.';
    expect(incoming(text, "greg")).toEqual({ from: "hive-e8", text: "What is waiting on Greg?" });
  });

  test("comb's relay header inside the envelope wins over the relay's own name", () => {
    const inner = 'Message from acme-api. Reply with the comb agent_send tool to "acme-api".\n\nTK-143 is green.';
    const text = `Another Claude session sent a message:\n<cross-session-message from-name="relay-x9">\n${inner}\n</cross-session-message>`;
    expect(incoming(text, "greg")).toEqual({ from: "acme-api", text: "TK-143 is green." });
  });

  test("the page's signature means Greg, and its note to the agent is dropped", () => {
    const text = `Greg, on the comb page:\n(He reads your answer on the page. Answer in your reply; do not use agent_send for it.)\n\nWhat's waiting on me?`;
    expect(incoming(text, "comb")).toEqual({ from: "greg", text: "What's waiting on me?" });
  });

  test("any configured name's signature means the human; old and new transcripts both parse", () => {
    for (const Name of ["Greg", "Ada", "The user"]) {
      const text = `${pageSignature(Name)}\n(${Name} reads your answer on the page. Answer in your reply; do not use agent_send for it.)\n\nShip it.`;
      expect(incoming(text, "comb")).toEqual({ from: "greg", text: "Ship it." });
    }
    expect(pageSignature("Greg")).toBe("Greg, on the comb page:");
    // A message that merely mentions the page later on is not a signature.
    expect(incoming("Look at this, on the comb page: the queue.", "maya")?.from).toBe("maya");
  });

  test("comb's start and restart prompts are comb's, not Greg's", () => {
    expect(incoming("You were restarted from your workspace. Read charter.md, then carry on.", "greg")?.from).toBe("comb");
    expect(incoming("Read your charter.md and checklist.md, then begin.", "greg")?.from).toBe("comb");
  });

  test("a prompt that merely starts with 'Message from' stays the default sender's", () => {
    expect(incoming("Message from the board. They want numbers by Friday.", "greg")).toEqual({
      from: "greg",
      text: "Message from the board. They want numbers by Friday.",
    });
  });

  test("harness noise is not a message", () => {
    expect(incoming("<command-name>/clear</command-name>", "greg")).toBeNull();
    expect(incoming("<local-command-stdout>ok</local-command-stdout>", "greg")).toBeNull();
    expect(incoming("[Request interrupted by user]", "greg")).toBeNull();
    expect(incoming("   ", "greg")).toBeNull();
  });
});

describe("parseLines and settle", () => {
  test("turns a transcript into messages, words, tool calls with results, and turn ends", () => {
    const lines = [
      user("What's next?"),
      assistant([
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "Looking." },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/src/a.ts" } },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "bun test", description: "Run the tests" } },
      ]),
      user([{ type: "tool_result", tool_use_id: "t1", content: "..." }, { type: "tool_result", tool_use_id: "t2", is_error: true, content: "boom" }]),
      line({ type: "system", subtype: "turn_duration", durationMs: 4200, uuid: "s1", timestamp: "2026-11-11T22:00:05Z" }),
      "{not json",
      line({ type: "assistant", isSidechain: true, uuid: "side", message: { content: [{ type: "text", text: "sub-agent chatter" }] } }),
    ];
    const events = settle(parseLines(lines, "greg", "/repo"));
    expect(events.map((e) => e.k)).toEqual(["in", "say", "tool", "tool", "idle"]);
    expect(events[2]).toMatchObject({ name: "Read", detail: "src/a.ts", status: "ok" });
    expect(events[3]).toMatchObject({ name: "Bash", detail: "Run the tests", status: "err" });
    expect(events[4]).toMatchObject({ ms: 4200 });
  });

  test("a message to an idle live session arrives as a meta line and still shows", () => {
    const text = `Another Claude session sent a message:\n<cross-session-message from-name="comb-79">\nGreg, on the comb page:\n(He reads your answer on the page. Answer in your reply; do not use agent_send for it.)\n\ndo I need the side chat?\n</cross-session-message>`;
    const events = parseLines([user(text, { isMeta: true }), user("<system-reminder>noise</system-reminder>", { isMeta: true }), user("plain meta", { isMeta: true })], "maya");
    expect(events).toEqual([expect.objectContaining({ k: "in", from: "greg", text: "do I need the side chat?" })]);
  });

  test("MCP tools show their own name, and agent_send shows its recipient", () => {
    const [e] = parseLines([assistant([{ type: "tool_use", id: "x", name: "mcp__comb__agent_send", input: { to: "maya", message: "hi" } }])], "greg");
    expect(e).toMatchObject({ k: "tool", name: "agent_send", detail: "to maya" });
  });

  test("long details are cut to one line", () => {
    const d = toolDetail("Bash", { command: "echo " + "x".repeat(300) + "\n\nnext" });
    expect(d.length).toBe(140);
    expect(d).not.toContain("\n");
  });

  test("recentOf keeps the last few events worth a line, oldest first", () => {
    const events = settle(parseLines([
      user("go"),
      assistant([{ type: "tool_use", id: "a", name: "Read", input: { file_path: "/r/x" } }]),
      assistant([{ type: "text", text: "**Done.** Next\nmore" }]),
    ], "greg"));
    expect(recentOf(events, 2)).toEqual([
      { kind: "tool", tool: "Read", text: "/r/x", at: "2026-11-11T22:00:01Z" },
      { kind: "say", text: "Done. Next", at: "2026-11-11T22:00:01Z" },
    ]);
  });
});

describe("transcriptPath", () => {
  test("follows Claude Code's project folder naming", () => {
    expect(transcriptPath("/Users/g/work/my.app", "abc", "/c")).toBe("/c/projects/-Users-g-work-my-app/abc.jsonl");
  });
});

describe("Tail", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "comb-tail-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test("history settles results; next returns only whole appended lines", async () => {
    const path = join(dir, "t.jsonl");
    await writeFile(path, [
      user("hello"),
      assistant([{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }]),
      user([{ type: "tool_result", tool_use_id: "t1", content: "" }]),
    ].join("\n") + "\n");
    const tail = new Tail(path, "greg", "");
    const history = await tail.history();
    expect(history.map((e) => e.k)).toEqual(["in", "tool"]);
    expect(history[1]).toMatchObject({ status: "ok" });
    expect(await tail.next()).toEqual([]);

    // A line half written: nothing yet. Then its end arrives.
    const next = assistant([{ type: "text", text: "Here — with a non-ASCII dash" }]);
    const cut = Buffer.from(next).length - 5;
    await appendFile(path, Buffer.from(next).subarray(0, cut));
    expect(await tail.next()).toEqual([]);
    await appendFile(path, Buffer.concat([Buffer.from(next).subarray(cut), Buffer.from("\n")]));
    const got = await tail.next();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ k: "say", text: "Here — with a non-ASCII dash" });
  });

  test("a missing transcript is empty, not an error", async () => {
    const tail = new Tail(join(dir, "nope.jsonl"), "greg", "");
    expect(await tail.history()).toEqual([]);
    expect(await tail.next()).toEqual([]);
  });
});

describe("snapshot", () => {
  let home: string;
  let claudeHome: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "comb-home-"));
    claudeHome = await mkdtemp(join(tmpdir(), "comb-claude-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
  });

  async function agent(name: string, parent: string, sessionId: string, cwd = "/w") {
    const dir = join(home, "agents", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "charter.md"), `# ${name} charter\n\nbody\n`);
    await writeFile(join(dir, "session.json"), JSON.stringify({ name, sessionId, parent, cwd, project: null }));
  }

  test("joins agents with live sessions and splits the rest into Greg's and others", async () => {
    await agent("maya", "greg", "s-maya");
    await agent("shop", "maya", "s-rev");
    await mkdir(join(claudeHome, "projects", "-w"), { recursive: true });
    await writeFile(join(claudeHome, "projects", "-w", "s-maya.jsonl"),
      assistant([{ type: "tool_use", id: "t", name: "Edit", input: { file_path: "/w/x.ts" } }]) + "\n");

    const snap = await buildSnapshot({
      home,
      claudeHome,
      live: [
        { id: "1", sessionId: "s-maya", name: "maya", cwd: "/w", kind: "background", status: "busy", state: "working" },
        { id: "0", sessionId: "s-old", name: "maya", cwd: "/w", kind: "background", state: "blocked" },
        { id: "2", sessionId: "s-greg", name: "shop-3a", cwd: "/r", kind: "interactive", status: "idle" },
        { id: "3", sessionId: "s-bg", name: "t1-search", cwd: "/c", kind: "background", status: "busy" },
        { id: "4", sessionId: "s-done", name: "gone", cwd: "/c", kind: "background", state: "done" },
      ],
    });
    expect(snap.agents.map((a) => [a.name, a.parent, a.activity])).toEqual([["maya", "greg", "working"], ["shop", "maya", "asleep"]]);
    expect(snap.agents[0]!.now).toMatchObject({ kind: "tool", tool: "Edit", text: "x.ts" });
    expect(snap.agents[0]!.about).toBe("maya charter");
    expect(snap.mine.map((s) => [s.name, s.activity])).toEqual([["shop-3a", "waiting"]]);
    expect(snap.others.map((s) => s.name)).toEqual(["t1-search"]);
  });

  test("a reported agent whose transcript is gone folds by its log's age", async () => {
    await agent("maya", "greg", "s-maya");
    await agent("shipped", "maya", "s-shipped");
    await agent("fresh", "maya", "s-fresh");
    for (const name of ["shipped", "fresh"]) {
      await mkdir(join(home, "agents", name, "reports"), { recursive: true });
      await writeFile(join(home, "agents", name, "reports", "2026-11-01-done.md"), "done\n");
      await writeFile(join(home, "agents", name, "log.md"), "- did it\n");
    }
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await utimes(join(home, "agents", "shipped", "log.md"), old, old);

    const snap = await buildSnapshot({ home, claudeHome, live: [] });
    expect(snap.agents.map((a) => [a.name, a.reports, a.finished])).toEqual([
      ["fresh", 1, false],
      ["maya", 0, false],
      ["shipped", 1, true],
    ]);
  });

  test("a now line from the user carries the userName from config.json, not \"greg\"", async () => {
    await agent("maya", "greg", "s-maya");
    await agent("shop", "maya", "s-shop");
    await mkdir(join(claudeHome, "projects", "-w"), { recursive: true });
    await mkdir(join(claudeHome, "projects", "-r"), { recursive: true });
    await writeFile(join(claudeHome, "projects", "-w", "s-maya.jsonl"), user("what's waiting on me?") + "\n");
    await writeFile(join(claudeHome, "projects", "-w", "s-shop.jsonl"), user("TK-42 is next") + "\n");
    await writeFile(join(claudeHome, "projects", "-r", "s-mine.jsonl"), user("ship it") + "\n");
    const live = [{ id: "2", sessionId: "s-mine", name: "web-3f", cwd: "/r", kind: "interactive", status: "idle" }];
    const lines = async () => {
      const snap = await buildSnapshot({ home, claudeHome, live });
      return [...snap.agents.map((a) => a.now?.text), snap.mine[0]!.now?.text];
    };

    await writeFile(join(home, "config.json"), JSON.stringify({ userName: "Ada" }));
    expect(await lines()).toEqual(["Ada: what's waiting on me?", "maya: TK-42 is next", "Ada: ship it"]);
    // Tails are cached by size; a renamed user still shows at once.
    await writeFile(join(home, "config.json"), JSON.stringify({ userName: "Bea" }));
    expect((await lines())[0]).toBe("Bea: what's waiting on me?");
  });

  test("the fold window comes from foldAfterHours in config.json, one day by default", async () => {
    await agent("maya", "greg", "s-maya");
    await agent("yesterday", "maya", "s-y");
    const dir = join(home, "agents", "yesterday");
    await mkdir(join(dir, "reports"), { recursive: true });
    await writeFile(join(dir, "reports", "2026-11-14-done.md"), "done\n");
    await writeFile(join(dir, "log.md"), "- did it\n");
    const t = new Date(Date.now() - 30 * 60 * 60 * 1000);
    await utimes(join(dir, "log.md"), t, t);
    const folded = async () => (await buildSnapshot({ home, claudeHome, live: [] })).agents.find((a) => a.name === "yesterday")!.finished;

    expect(await folded()).toBe(true);
    await writeFile(join(home, "config.json"), JSON.stringify({ foldAfterHours: 48 }));
    expect(await folded()).toBe(false);
  });

  test("activity: busy is working, a live idle session is waiting, an ended one asleep", () => {
    expect(activityOf({ id: "", sessionId: "", name: "", cwd: "", kind: "background", status: "busy" })).toBe("working");
    expect(activityOf({ id: "", sessionId: "", name: "", cwd: "", kind: "background", status: "idle", state: "blocked" })).toBe("waiting");
    expect(activityOf({ id: "", sessionId: "", name: "", cwd: "", kind: "background", state: "blocked" })).toBe("asleep");
    expect(activityOf(undefined)).toBe("asleep");
  });
});

describe("the Finished fold (D22)", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now - h * 60 * 60 * 1000).toISOString();
  const daysAgo = (d: number) => hoursAgo(d * 24);
  type A = Parameters<typeof foldedAgents>[0][number];
  const a = (name: string, o: Partial<A> = {}): A =>
    ({ name, parent: "maya", activity: "asleep", lastActive: daysAgo(8), reports: 1, ...o });

  test("the window is one day", () => {
    expect(FOLD_AFTER_MS).toBe(24 * 60 * 60 * 1000);
  });

  test("a reported agent idle 25 hours folds; 23 hours stays", () => {
    const got = foldedAgents([a("old", { lastActive: hoursAgo(25) }), a("recent", { lastActive: hoursAgo(23) })], now);
    expect([...got]).toEqual(["old"]);
  });

  test("a longer window from config.json keeps a 25-hour-idle agent in the list", () => {
    const agents = [a("old", { lastActive: hoursAgo(25) }), a("older", { lastActive: hoursAgo(73) })];
    expect([...foldedAgents(agents, now, 72 * 60 * 60 * 1000)]).toEqual(["older"]);
  });

  test("an agent with no report never folds, however old", () => {
    expect(foldedAgents([a("silent", { reports: 0, lastActive: daysAgo(90) })], now).size).toBe(0);
  });

  test("maya never folds", () => {
    expect(foldedAgents([a("maya", { parent: "greg", lastActive: daysAgo(90) })], now).size).toBe(0);
  });

  test("a parent with a child still in the list stays; when the child folds, so does the parent", () => {
    const parent = a("lead");
    expect([...foldedAgents([parent, a("kid", { parent: "lead", lastActive: hoursAgo(2) })], now)]).toEqual([]);
    expect([...foldedAgents([parent, a("kid", { parent: "lead" })], now)].sort()).toEqual(["kid", "lead"]);
  });

  test("a grandchild in the list keeps the whole line up", () => {
    const got = foldedAgents([a("lead"), a("mid", { parent: "lead" }), a("leaf", { parent: "mid", activity: "working" })], now);
    expect(got.size).toBe(0);
  });

  test("a woken agent is working and returns to the list", () => {
    expect(foldedAgents([a("woken", { activity: "working" })], now).size).toBe(0);
  });

  test("an agent with no known activity time stays", () => {
    expect(foldedAgents([a("unknown", { lastActive: null })], now).size).toBe(0);
  });

  test("a parent cycle does not loop", () => {
    expect([...foldedAgents([a("x", { parent: "y" }), a("y", { parent: "x" })], now)].sort()).toEqual(["x", "y"]);
  });

  test("an open session never folds, however long it has been quiet", () => {
    // A terminal tab Greg keeps open for weeks is a workspace, not finished work.
    expect(sessionFolds({ activity: "waiting", ended: false, lastActive: daysAgo(18), startedAt: daysAgo(18) }, now)).toBe(false);
    expect(sessionFolds({ activity: "waiting", ended: false, lastActive: null, startedAt: daysAgo(30) }, now)).toBe(false);
    expect(sessionFolds({ activity: "working", ended: false, lastActive: daysAgo(8), startedAt: null }, now)).toBe(false);
  });

  test("an ended session folds after one idle day, by last activity or start", () => {
    expect(sessionFolds({ activity: "asleep", ended: true, lastActive: hoursAgo(25), startedAt: null }, now)).toBe(true);
    expect(sessionFolds({ activity: "asleep", ended: true, lastActive: hoursAgo(23), startedAt: daysAgo(30) }, now)).toBe(false);
    expect(sessionFolds({ activity: "asleep", ended: true, lastActive: null, startedAt: hoursAgo(25) }, now)).toBe(true);
    expect(sessionFolds({ activity: "asleep", ended: true, lastActive: null, startedAt: null }, now)).toBe(false);
    expect(sessionFolds({ activity: "asleep", ended: true, lastActive: hoursAgo(25), startedAt: null }, now, 48 * 60 * 60 * 1000)).toBe(false);
  });

  test("a live terminal session quiet for days stays in Your sessions", async () => {
    const home = await mkdtemp(join(tmpdir(), "comb-mine-"));
    const live = [{ sessionId: "s-tab", name: "tab-3a", kind: "interactive", status: "idle", cwd: "/nowhere/tab", startedAt: now - 18 * 86_400_000 }] as any;
    const snap = await buildSnapshot({ home, claudeHome: join(home, "claude"), live });
    expect(snap.mine.map((s) => [s.name, s.finished])).toEqual([["tab-3a", false]]);
  });
});

describe("the rail's tree order", () => {
  type R = Parameters<typeof treeOrder>[0][number];
  const r = (name: string, lastActive: string | null, o: Partial<R> = {}): R =>
    ({ name, parent: "maya", activity: "asleep", lastActive, ...o });

  test("maya first; under a parent, live work, then the most recent activity, then the name", () => {
    const rows = treeOrder([
      r("maya", "2026-11-01T00:00:00.000Z", { parent: "greg" }),
      r("alpha", "2026-11-14T09:00:00.000Z"),
      r("beta", "2026-11-15T09:00:00.000Z"),
      r("gamma", "2026-11-10T09:00:00.000Z", { activity: "working" }),
      r("delta", null),
      r("eps", "2026-11-15T09:00:00.000Z"),
      r("kid-old", "2026-11-12T00:00:00.000Z", { parent: "alpha" }),
      r("kid-new", "2026-11-13T00:00:00.000Z", { parent: "alpha" }),
      r("solo", "2026-11-15T10:00:00.000Z", { parent: "greg" }),
    ]);
    expect(rows.map((x) => [x.node.name, x.depth])).toEqual([
      ["maya", 1],
      ["gamma", 2],
      ["beta", 2],
      ["eps", 2],
      ["alpha", 2],
      ["kid-new", 3],
      ["kid-old", 3],
      ["delta", 2],
      ["solo", 1],
    ]);
  });
});

describe("parseTicketLine", () => {
  test("reads hive's list_tickets line with tags and blockers", () => {
    expect(parseTicketLine("acme-api", "TK-142  in_progress  P1-high       feature  Rate limiter [api, perf] (blocked by: TK-140, TK-141)")).toEqual({
      project: "acme-api", id: "TK-142", status: "in_progress", priority: 1, type: "feature",
      title: "Rate limiter", tags: ["api", "perf"], blockedBy: ["TK-140", "TK-141"],
    });
  });
  test("a plain title, and lines that are not tickets", () => {
    expect(parseTicketLine("x", "TK-004  open         P2-medium     task     Deterministic post: fee = sum(parts)")).toMatchObject({
      title: "Deterministic post: fee = sum(parts)", tags: [], blockedBy: [], priority: 2,
    });
    expect(parseTicketLine("x", "65 ticket(s):")).toBeNull();
    expect(parseTicketLine("x", "")).toBeNull();
  });
});

describe("page service", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "comb-svc-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /** A fake launchctl. bootstrapCodes and kickstartCode are its exit codes, in call order. */
  function fakeLaunchctl(o: { bootstrapCodes?: number[]; kickstartCode?: number } = {}) {
    const calls: string[][] = [];
    const bootstraps = [...(o.bootstrapCodes ?? [])];
    const run: Run = async (argv) => {
      calls.push(argv);
      if (argv[1] === "bootout") return { code: 3, stdout: "", stderr: "No such process" };
      if (argv[1] === "kickstart") {
        const code = o.kickstartCode ?? 0;
        return { code, stdout: "", stderr: code ? "Could not find service \"com.comb.page\" in domain for user gui: 501" : "" };
      }
      const code = bootstraps.shift() ?? 0;
      return { code, stdout: "", stderr: code ? "Bootstrap failed: 5: Input/output error" : "" };
    };
    return { calls, run };
  }

  async function setup(lc: ReturnType<typeof fakeLaunchctl>) {
    const bin = join(dir, "comb");
    await writeFile(bin, "");
    const agents = join(dir, "LaunchAgents");
    const plistPath = join(agents, "com.comb.page.plist");
    return { bin, plistPath, opts: { home: join(dir, "home"), bin, launchAgentsDir: agents, run: lc.run, uid: 501, retryDelayMs: 0 } };
  }
  const reload = (plistPath: string) => [
    ["launchctl", "bootout", "gui/501/com.comb.page"],
    ["launchctl", "bootstrap", "gui/501", plistPath],
  ];

  test("installs a login agent that runs the installed binary through /bin/sh", async () => {
    const lc = fakeLaunchctl();
    const { bin, plistPath, opts } = await setup(lc);

    expect(await installPageService(opts)).toContain("installed com.comb.page");
    const plist = await Bun.file(plistPath).text();
    // BTM keys the login item on the program's code requirement; /bin/sh's never changes (TK-006).
    expect(plist).toContain(`<array>\n        <string>/bin/sh</string>\n        <string>-c</string>\n        <string>exec "$0" "$@"</string>\n        <string>${bin}</string>\n        <string>page</string>\n        <string>--serve</string>`);
    expect(plist).toContain("<key>KeepAlive</key>\n    <true/>");
    expect(plist).toContain("/opt/homebrew/bin"); // launchd's bare PATH would not find bun or claude
    expect(lc.calls).toEqual(reload(plistPath));
  });

  test("the plist's /bin/sh line runs the binary with the page's arguments", async () => {
    const lc = fakeLaunchctl();
    const { plistPath, opts } = await setup(lc);
    await installPageService(opts);
    const args = [...(await Bun.file(plistPath).text()).matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!);
    const argv = args.slice(args.indexOf("/bin/sh"), args.indexOf("/bin/sh") + 8);
    const echo = join(dir, "echo-args");
    await writeFile(echo, `#!/bin/sh\nprintf '%s|' "$@"\n`, { mode: 0o755 });
    argv[3] = echo;
    const out = Bun.spawnSync(argv).stdout.toString();
    expect(out).toBe("page|--serve|--port|4747|");
  });

  test("an unchanged plist is left alone and the running service is restarted in place", async () => {
    const lc = fakeLaunchctl();
    const { plistPath, opts } = await setup(lc);
    await installPageService(opts);
    const mtime = (await stat(plistPath)).mtimeMs;
    lc.calls.length = 0;
    await Bun.sleep(20);

    expect(await installPageService(opts)).toContain("restarted com.comb.page on the installed binary (plist unchanged)");
    expect(lc.calls).toEqual([["launchctl", "kickstart", "-k", "gui/501/com.comb.page"]]);
    // Rewriting it, even with the same bytes, makes BTM re-check the item.
    expect((await stat(plistPath)).mtimeMs).toBe(mtime);
  });

  test("when kickstart fails, it reloads instead and says why", async () => {
    const first = fakeLaunchctl();
    const { plistPath, opts } = await setup(first);
    await installPageService(opts);

    const lc = fakeLaunchctl({ kickstartCode: 113 });
    const line = await installPageService({ ...opts, run: lc.run });
    expect(line).toContain("reloaded com.comb.page (kickstart failed, exit 113: Could not find service");
    expect(line).toContain("reloaded instead)");
    expect(lc.calls).toEqual([["launchctl", "kickstart", "-k", "gui/501/com.comb.page"], ...reload(plistPath)]);
  });

  test("a changed plist is rewritten and reloaded", async () => {
    const lc = fakeLaunchctl();
    const { plistPath, opts } = await setup(lc);
    await installPageService(opts);
    lc.calls.length = 0;

    expect(await installPageService({ ...opts, port: 4800 })).toContain("reloaded com.comb.page, serving http://127.0.0.1:4800");
    expect(await Bun.file(plistPath).text()).toContain("<string>4800</string>");
    expect(lc.calls).toEqual(reload(plistPath));
  });

  test("retries a bootstrap that fails once (launchd's exit-5 race)", async () => {
    const lc = fakeLaunchctl({ bootstrapCodes: [5, 0] });
    const { plistPath, opts } = await setup(lc);
    expect(await installPageService(opts)).toContain("installed com.comb.page");
    expect(lc.calls).toEqual([...reload(plistPath), ["launchctl", "bootstrap", "gui/501", plistPath]]);
  });

  test("says so when comb is not installed, and fails visibly when launchd refuses twice", async () => {
    const agents = join(dir, "LaunchAgents");
    expect(await installPageService({ home: dir, bin: join(dir, "missing"), launchAgentsDir: agents, run: fakeLaunchctl().run })).toContain("not installed yet");
    const lc = fakeLaunchctl({ bootstrapCodes: [5, 5] });
    const { opts } = await setup(lc);
    await expect(installPageService(opts)).rejects.toThrow("launchctl bootstrap failed (exit 5) twice: Bootstrap failed: 5");
  });

  test("when kickstart and both bootstraps fail, the error carries the kickstart failure too", async () => {
    const { opts } = await setup(fakeLaunchctl());
    await installPageService(opts);
    const lc = fakeLaunchctl({ kickstartCode: 113, bootstrapCodes: [5, 5] });
    await expect(installPageService({ ...opts, run: lc.run })).rejects.toThrow(/twice: .*kickstart failed, exit 113/);
  });

  test("escapes paths in the plist", () => {
    expect(pagePlist({ bin: "/a&b/comb", home: "/h", port: 4747, userHome: "/u" })).toContain("<string>/a&amp;b/comb</string>");
  });
});

describe("parseMemory", () => {
  test("reads sections, dates and tags, and drops the provenance trail", () => {
    const text = [
      "# Project Memory: mobile-app",
      "",
      "## Durable Facts",
      "- The app targets iOS 17 and later. [platform, ios]",
      "- Worktrees branch from HEAD. [subagents, worktrees] _provenance:_ project=mobile-app topRanked[8] [reflection]",
      "## Decisions",
      "- [2026-11-05] A signed-in user.s page lives at /me (TK-034). [auth, routes]",
      "## Open Questions",
      "- Who owns the app store listing?",
      "## Something Else",
      "- ignored",
    ].join("\n");
    expect(parseMemory(text)).toEqual([
      { section: "facts", date: null, text: "The app targets iOS 17 and later.", tags: ["platform", "ios"] },
      { section: "facts", date: null, text: "Worktrees branch from HEAD.", tags: ["subagents", "worktrees"] },
      { section: "decisions", date: "2026-11-05", text: "A signed-in user.s page lives at /me (TK-034).", tags: ["auth", "routes"] },
      { section: "questions", date: null, text: "Who owns the app store listing?", tags: [] },
    ]);
  });
});
