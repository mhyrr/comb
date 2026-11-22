import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { listItems } from "../queue";
import { awayOf, buildTimeline, logSessions, readAgentLanes, spansOf, type AgentSessions, type TimelineInput } from "../timeline";
import { UsageIndex, defaultRoots, type TurnRec } from "../usage";
import { laneState, summaryLine, timelineHtml, type TimelineCtx } from "../page/ui/timeline";

const NOW = Date.parse("2026-11-19T21:47:00Z");
const min = (m: number) => NOW - m * 60_000;
const turn = (id: string, session: string, endMinAgo: number, lenMin: number, extra: Partial<TurnRec> = {}): TurnRec =>
  ({ id, session, end: min(endMinAgo), ms: lenMin * 60_000, ...extra });
const agent = (name: string, sessions: string[], reports: { file: string; at: number }[] = []): AgentSessions =>
  ({ name, sessions, current: sessions.at(-1) ?? null, reports });

const base = (over: Partial<TimelineInput> = {}): TimelineInput => ({
  now: NOW,
  agents: [
    agent("maya", ["aaaa0001-full-id", "aaaa0002"]),
    agent("docs-search", ["dddd0001-full-id"], [{ file: "2026-11-19-search.md", at: min(183) }]),
    agent("asleep-all-day", ["eeee0001-full-id"]),
  ],
  turns: [
    turn("t1", "aaaa0001-full-id", 600, 5),
    turn("t2", "aaaa0002-0000-resumed", 40, 3), // a woken Maya: a new session, known from log.md's short id
    turn("t3", "dddd0001-full-id", 240, 60),
    turn("t4", "dddd0001-full-id", 180, 59), // 1 minute after t3: one bar
    turn("t-old", "dddd0001-full-id", 60 * 30, 10), // before the window
    turn("u1", "you-session-1", 780, 55),
    turn("u2", "you-session-1", 30, 20),
    turn("p1", "relay-session", 100, 1, { sdk: true }), // comb's haiku relay
    turn("b1", "other-bg-session", 100, 30), // someone's background session, not an agent
  ],
  activity: [{ session: "aaaa0002", ts: min(5) }, { session: "aaaa0002", ts: min(3) }],
  calls: [{ session: "dddd0001-full-id", ts: min(200) }, { session: "dddd0001-full-id", ts: min(190) }],
  queue: [
    { id: "q1", kind: "review", from: "docs-search", title: "Review: docs search", created: new Date(min(180)).toISOString(), answered: null },
    { id: "q2", kind: "decision", from: "maya", title: "Store: Postgres or Redis", created: new Date(min(39)).toISOString(), answered: new Date(min(20)).toISOString() },
    { id: "q3", kind: "blocker", from: "maya", title: "No token", created: new Date(min(60 * 30)).toISOString(), answered: null }, // before the window
  ],
  background: new Set(["other-bg-session"]),
  ...over,
});

describe("timeline derivation", () => {
  test("lanes: turns become bars, merged and clipped, owned through session.json and log.md's short ids", () => {
    const t = buildTimeline(base());
    expect(t.lanes.map((l) => l.name)).toEqual(["maya", "docs-search"]);
    expect(t.quiet).toBe(1); // asleep-all-day
    const ds = t.lanes.find((l) => l.name === "docs-search")!;
    expect(ds.spans).toEqual([{ s: min(300), e: min(180), turns: 2, calls: 2 }]);
    expect(ds.marks.map((m) => [m.kind, m.at])).toEqual([["finished", min(183)], ["asked", min(180)]]);
    const maya = t.lanes.find((l) => l.name === "maya")!;
    expect(maya.spans.map((s) => [s.s, s.e])).toEqual([[min(605), min(600)], [min(43), min(40)]]);
    expect(maya.marks).toMatchObject([{ kind: "asked", at: min(39), answeredAt: min(20) }]);
    // Calls after her current session's last turn: a turn still running since then.
    expect(maya.openSince).toBe(min(5));
  });

  test("your sessions: the rest, minus claude -p runs and Claude Code's background sessions; away is the last hour-plus gap", () => {
    const t = buildTimeline(base());
    expect(t.you!.spans.map((s) => [s.s, s.e])).toEqual([[min(835), min(780)], [min(50), min(30)]]);
    expect(t.away).toEqual({ s: min(780), e: min(50) });
    // Without the background list, the user's sessions can't be told apart: no lane, and the page says why.
    const blind = buildTimeline(base({ background: null }));
    expect(blind.you).toBeNull();
    expect(blind.youNote).toContain("could not be read");
    expect(blind.away).toBeNull();
  });

  test("away counts the stretch up to now, and nothing shorter than an hour", () => {
    const sp = (s: number, e: number) => ({ s: min(s), e: min(e), turns: 1, calls: 0 });
    expect(awayOf([sp(300, 200)], NOW)).toEqual({ s: min(200), e: NOW });
    expect(awayOf([sp(300, 200), sp(170, 10)], NOW)).toBeNull();
    expect(awayOf([], NOW)).toBeNull();
  });

  test("spans: a bar that started before the window is clipped to it; a short gap merges, a long one does not", () => {
    const start = min(24 * 60);
    expect(spansOf([{ s: start - 600_000, e: start + 600_000 }], [], start, NOW)).toEqual([{ s: start, e: start + 600_000, turns: 1, calls: 0 }]);
    expect(spansOf([{ s: min(30), e: min(20) }, { s: min(17), e: min(10) }], [], start, NOW)).toHaveLength(2);
  });

  test("log.md: the session ids on started-by and resumed-by lines", () => {
    const log = [
      "- 2026-11-17T21:45:46.364Z started by maya in /work/comb (session 6bdba98e, model opus)",
      "- 2026-11-17T22:10Z merged origin/main; nothing to do with sessions",
      "- 2026-11-19T15:40:01.000Z resumed by maya in /work/comb (session 1b3b4c82, model opus)",
    ].join("\n");
    expect(logSessions(log)).toEqual(["6bdba98e", "1b3b4c82"]);
  });
});

describe("timeline from the fixture world", () => {
  let dir: string;
  let t: ReturnType<typeof buildTimeline>;
  let lanes: AgentSessions[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "comb-timeline-"));
    const build = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../../scripts/fixture/build.ts"), dir]);
    if (build.exitCode !== 0) throw new Error(build.stderr.toString());
    const home = join(dir, "home");
    const ix = new UsageIndex({ roots: defaultRoots(home), cachePath: null });
    await ix.refresh();
    lanes = await readAgentLanes(join(home, ".comb"));
    const live = JSON.parse(readFileSync(join(home, "live.json"), "utf-8")) as { sessionId: string; kind: string }[];
    const calls = ix.toolCalls();
    t = buildTimeline({
      now: Date.now(),
      agents: lanes,
      turns: ix.turns(),
      activity: [...calls, ...ix.records("claude")],
      calls,
      queue: await listItems(join(home, ".comb")),
      background: new Set(live.filter((r) => r.kind === "background").map((r) => r.sessionId)),
    });
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  const near = (ms: number, minAgo: number) => Math.abs(ms - (Date.now() - minAgo * 60_000)) < 3 * 60_000;

  test("Maya's log line carries her session id, and her lane holds her day", () => {
    expect(lanes.find((a) => a.name === "maya")!.sessions).toContain("a1b2c3d4");
    const maya = t.lanes[0]!;
    expect(maya.name).toBe("maya");
    expect(maya.spans.length).toBe(5); // the morning sweep, starting docs search, TK-42, the store question, "what's waiting"
    expect(maya.marks.filter((m) => m.kind === "asked").length).toBe(3); // the decision and the proposal she filed, and the pick the sweep withdrew
    // A withdrawn ask is closed (TK-008): its ring fills at the withdrawal, not left waiting.
    const gone = maya.marks.find((m) => m.kind === "asked" && m.id.includes("docs-site-tk-15"));
    expect(gone && gone.kind === "asked" ? gone.answeredAt : null).toBeNumber();
  });

  test("docs-site-search: one two-hour turn ending when its log says it wrote the report, then the review it asked for", () => {
    // log.md: started 300 minutes ago, "wrote the report and told maya" 180 minutes ago.
    const ds = t.lanes.find((l) => l.name === "docs-site-search")!;
    expect(ds.spans).toHaveLength(1);
    expect(near(ds.spans[0]!.s, 300) && near(ds.spans[0]!.e, 180)).toBe(true);
    expect(ds.marks.map((m) => m.kind)).toEqual(["finished", "asked"]);
  });

  test("the working agent's open turn starts after the turn that ended when it asked Maya", () => {
    const rl = t.lanes.find((l) => l.name === "acme-api-tk42-rate-limits")!;
    expect(rl.spans).toHaveLength(1);
    expect(near(rl.spans[0]!.e, 42)).toBe(true);
    expect(rl.openSince !== null && near(rl.openSince, 10)).toBe(true);
  });

  test("the agent that finished nine days ago is quiet, and the user's own session is its own lane with an away gap", () => {
    expect(t.lanes.map((l) => l.name)).not.toContain("web-app-bundle-size");
    expect(t.quiet).toBe(1);
    expect(t.you!.spans).toHaveLength(3);
    expect(t.away && near(t.away.s, 60 * 7) && near(t.away.e, 30 + 140 / 60)).toBe(true);
  });
});

describe("the timeline on the page", () => {
  const ctx = (over: Partial<TimelineCtx> = {}): TimelineCtx => ({
    now: NOW,
    agents: [
      { name: "maya", activity: "working", about: "Chief of staff" },
      { name: "docs-search", activity: "asleep", about: "Client-side <search>" },
    ],
    mine: [],
    queue: [{ status: "open", kind: "review", from: "docs-search", created: new Date(min(180)).toISOString() }],
    who: (n) => (n === "maya" ? "Maya" : n),
    userName: "Greg",
    clock: (ms) => new Date(ms).toISOString().slice(11, 16),
    hour: (ms) => new Date(ms).toISOString().slice(11, 13),
    ...over,
  });

  test("state in words: working with its turn length, waiting with its age, finished, asleep", () => {
    const t = buildTimeline(base());
    const [maya, ds] = [t.lanes[0]!, t.lanes[1]!];
    expect(laneState(maya, ctx())).toEqual({ word: "Working", sub: "5m on this turn", tone: "working" });
    expect(laneState(ds, ctx())).toEqual({ word: "Waiting on you", sub: "3h", tone: "waiting" });
    expect(laneState(ds, ctx({ queue: [] }))).toEqual({ word: "Finished", sub: `report ${new Date(min(183)).toISOString().slice(11, 16)}`, tone: "done" });
    expect(laneState(maya, ctx({ agents: [{ name: "maya", activity: "asleep", about: null }] })).word).toBe("Asleep");
    expect(laneState(ds, ctx({ queue: [{ status: "open", kind: "blocker", from: "docs-search", created: new Date(min(60)).toISOString() }] })))
      .toEqual({ word: "Blocked", sub: "1h", tone: "blocked" });
  });

  test("the summary says when you were away, who finished, who waits on you, who still works", () => {
    const line = summaryLine(buildTimeline(base()), ctx());
    expect(line).toBe(`You were away ${new Date(min(780)).toISOString().slice(11, 16)}–${new Date(min(50)).toISOString().slice(11, 16)}. <b>docs-search</b> finished; <b>docs-search</b> is waiting on you; <b>Maya</b> is still working.`);
  });

  test("the html: escaped, one labelled row per lane plus yours, a live bar only while working, and the quiet count", () => {
    const html = timelineHtml({ ready: true, error: null, ...buildTimeline(base()) }, ctx(), (n) => `#/agent/${n}`);
    expect(html).toContain("Client-side &lt;search&gt;");
    expect(html.match(/class="tl-lane[ "]/g)).toHaveLength(3);
    expect(html).toContain('class="tl-bar live"');
    expect(html).toContain("1 more agent did nothing in the last 24 hours.");
    expect(html).toContain('aria-label="docs-search: worked');
    expect(timelineHtml({ ready: true, error: null, ...buildTimeline(base()) }, ctx({ agents: [] }), (n) => n)).not.toContain("tl-bar live");
    expect(timelineHtml({ ready: false, error: "disk gone" }, ctx(), (n) => n)).toContain("Couldn't read transcripts: disk gone");
    expect(timelineHtml({ ready: false, error: null }, ctx(), (n) => n)).toContain("Reading transcripts…");
  });
});

describe("reading ~/.comb for the timeline", () => {
  test("each agent's sessions from session.json and log.md, and its report times", async () => {
    const home = await mkdtemp(join(tmpdir(), "comb-lanes-"));
    const dir = join(home, "agents", "x");
    await mkdir(join(dir, "reports"), { recursive: true });
    await writeFile(join(dir, "charter.md"), "# x\n");
    await writeFile(join(dir, "session.json"), JSON.stringify({ sessionId: "cccc0003-full" }));
    await writeFile(join(dir, "log.md"), "- t started by maya in /w (session cccc0001, model opus)\n- t resumed by maya in /w (session cccc0002, model opus)\n");
    await writeFile(join(dir, "reports", "r.md"), "# r\n");
    await utimes(join(dir, "reports", "r.md"), new Date(min(60)), new Date(min(60)));
    await mkdir(join(home, "agents", "not-an-agent"), { recursive: true }); // no charter
    const lanes = await readAgentLanes(home);
    expect(lanes).toEqual([{ name: "x", sessions: ["cccc0001", "cccc0002", "cccc0003-full"], current: "cccc0003-full", reports: [{ file: "r.md", at: min(60) }] }]);
    await rm(home, { recursive: true, force: true });
  });
});
