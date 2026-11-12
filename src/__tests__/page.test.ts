import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Run } from "../claude";
import { parseMemory, parseTicketLine } from "../hive";
import { Tail } from "../page/feed";
import { installPageService, pagePlist } from "../page/service";
import { activityOf, buildSnapshot, recentOf } from "../page/state";
import { incoming, parseLines, PAGE_SIGNATURE, settle, toolDetail, transcriptPath } from "../transcript";

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
    const inner = 'Message from revrec. Reply with the comb agent_send tool to "revrec".\n\nTK-143 is green.';
    const text = `Another Claude session sent a message:\n<cross-session-message from-name="relay-x9">\n${inner}\n</cross-session-message>`;
    expect(incoming(text, "greg")).toEqual({ from: "revrec", text: "TK-143 is green." });
  });

  test("the page's signature means Greg, and its note to the agent is dropped", () => {
    const text = `${PAGE_SIGNATURE}\n(He reads your answer on the page. Answer in your reply; do not use agent_send for it.)\n\nWhat's waiting on me?`;
    expect(incoming(text, "comb")).toEqual({ from: "greg", text: "What's waiting on me?" });
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
    const text = `Another Claude session sent a message:\n<cross-session-message from-name="comb-79">\n${PAGE_SIGNATURE}\n(He reads your answer on the page. Answer in your reply; do not use agent_send for it.)\n\ndo I need the side chat?\n</cross-session-message>`;
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
    await agent("revrec", "maya", "s-rev");
    await mkdir(join(claudeHome, "projects", "-w"), { recursive: true });
    await writeFile(join(claudeHome, "projects", "-w", "s-maya.jsonl"),
      assistant([{ type: "tool_use", id: "t", name: "Edit", input: { file_path: "/w/x.ts" } }]) + "\n");

    const snap = await buildSnapshot({
      home,
      claudeHome,
      live: [
        { id: "1", sessionId: "s-maya", name: "maya", cwd: "/w", kind: "background", status: "busy", state: "working" },
        { id: "0", sessionId: "s-old", name: "maya", cwd: "/w", kind: "background", state: "blocked" },
        { id: "2", sessionId: "s-greg", name: "revrec-3a", cwd: "/r", kind: "interactive", status: "idle" },
        { id: "3", sessionId: "s-bg", name: "t1-search", cwd: "/c", kind: "background", status: "busy" },
        { id: "4", sessionId: "s-done", name: "gone", cwd: "/c", kind: "background", state: "done" },
      ],
    });
    expect(snap.agents.map((a) => [a.name, a.parent, a.activity])).toEqual([["maya", "greg", "working"], ["revrec", "maya", "asleep"]]);
    expect(snap.agents[0]!.now).toMatchObject({ kind: "tool", tool: "Edit", text: "x.ts" });
    expect(snap.agents[0]!.about).toBe("maya charter");
    expect(snap.mine.map((s) => [s.name, s.activity])).toEqual([["revrec-3a", "waiting"]]);
    expect(snap.others.map((s) => s.name)).toEqual(["t1-search"]);
  });

  test("activity: busy is working, a live idle session is waiting, an ended one asleep", () => {
    expect(activityOf({ id: "", sessionId: "", name: "", cwd: "", kind: "background", status: "busy" })).toBe("working");
    expect(activityOf({ id: "", sessionId: "", name: "", cwd: "", kind: "background", status: "idle", state: "blocked" })).toBe("waiting");
    expect(activityOf({ id: "", sessionId: "", name: "", cwd: "", kind: "background", state: "blocked" })).toBe("asleep");
    expect(activityOf(undefined)).toBe("asleep");
  });
});

describe("parseTicketLine", () => {
  test("reads hive's list_tickets line with tags and blockers", () => {
    expect(parseTicketLine("revrec", "TK-142  in_progress  P1-high       feature  Rate limiter [api, perf] (blocked by: TK-140, TK-141)")).toEqual({
      project: "revrec", id: "TK-142", status: "in_progress", priority: 1, type: "feature",
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

  function fakeLaunchctl(bootstrapCode = 0) {
    const calls: string[][] = [];
    const run: Run = async (argv) => {
      calls.push(argv);
      if (argv[1] === "bootout") return { code: 3, stdout: "", stderr: "No such process" };
      return { code: bootstrapCode, stdout: "", stderr: bootstrapCode ? "Bootstrap failed: 5" : "" };
    };
    return { calls, run };
  }

  test("installs a login agent that runs the installed binary, then reloads it on the next init", async () => {
    const bin = join(dir, "comb");
    await writeFile(bin, "");
    const agents = join(dir, "LaunchAgents");
    const lc = fakeLaunchctl();
    const opts = { home: join(dir, "home"), bin, launchAgentsDir: agents, run: lc.run, uid: 501 };

    expect(await installPageService(opts)).toContain("installed com.comb.page");
    const plist = await Bun.file(join(agents, "com.comb.page.plist")).text();
    expect(plist).toContain(`<string>${bin}</string>\n        <string>page</string>\n        <string>--serve</string>`);
    expect(plist).toContain("<key>KeepAlive</key>\n    <true/>");
    expect(plist).toContain("/opt/homebrew/bin"); // launchd's bare PATH would not find bun or claude
    expect(lc.calls).toEqual([
      ["launchctl", "bootout", "gui/501/com.comb.page"],
      ["launchctl", "bootstrap", "gui/501", join(agents, "com.comb.page.plist")],
    ]);
    expect(await installPageService(opts)).toContain("reloaded com.comb.page");
  });

  test("says so when comb is not installed, and fails visibly when launchd refuses", async () => {
    const agents = join(dir, "LaunchAgents");
    expect(await installPageService({ home: dir, bin: join(dir, "missing"), launchAgentsDir: agents, run: fakeLaunchctl().run })).toContain("not installed yet");
    const bin = join(dir, "comb");
    await writeFile(bin, "");
    await expect(installPageService({ home: dir, bin, launchAgentsDir: agents, run: fakeLaunchctl(5).run, uid: 501 }))
      .rejects.toThrow("launchctl bootstrap failed");
  });

  test("escapes paths in the plist", () => {
    expect(pagePlist({ bin: "/a&b/comb", home: "/h", port: 4747, userHome: "/u" })).toContain("<string>/a&amp;b/comb</string>");
  });
});

describe("parseMemory", () => {
  test("reads sections, dates and tags, and drops the provenance trail", () => {
    const text = [
      "# Project Memory: arete",
      "",
      "## Durable Facts",
      "- What Arete is (Greg, 2026-11-02): a pathway. [vision, formation]",
      "- Worktrees branch from HEAD. [subagents, worktrees] _provenance:_ project=arete topRanked[8] [reflection]",
      "## Decisions",
      "- [2026-11-05] An adult's page lives at /me (TK-034). [auth, routes]",
      "## Open Questions",
      "- Who draws the illustrations?",
      "## Something Else",
      "- ignored",
    ].join("\n");
    expect(parseMemory(text)).toEqual([
      { section: "facts", date: null, text: "What Arete is (Greg, 2026-11-02): a pathway.", tags: ["vision", "formation"] },
      { section: "facts", date: null, text: "Worktrees branch from HEAD.", tags: ["subagents", "worktrees"] },
      { section: "decisions", date: "2026-11-05", text: "An adult's page lives at /me (TK-034).", tags: ["auth", "routes"] },
      { section: "questions", date: null, text: "Who draws the illustrations?", tags: [] },
    ]);
  });
});
