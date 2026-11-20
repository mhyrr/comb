/**
 * "What each agent did", the last 24 hours on Now (design doc
 * docs/design/2026-11-17-now-dashboard.md §4.2). One lane per agent that did
 * anything in the window, and one quiet lane for the user's own sessions.
 *
 * Where each mark comes from:
 *   bar       a finished turn, from Claude Code's `turn_duration` lines (the usage index)
 *   open bar  the current turn: tool calls and model calls after the session's last turn end
 *   asked     a queue item the agent filed (`created`); answered when it has `answered`
 *   blocked   a queue item of kind blocker
 *   finished  a file written to the agent's reports/ (its mtime)
 *
 * Agents own sessions through session.json and the `(session xxxxxxxx)` id
 * on every "started by" and "resumed by" line of log.md, because a woken agent
 * runs in a new session each time. The user's sessions are the rest of the
 * turns, minus `claude -p` runs and minus sessions Claude Code lists as
 * background (`claude agents --json --all`).
 *
 * `buildTimeline` is pure, so tests feed it fixture data; `readAgentLanes`
 * reads ~/.comb for it.
 */
import { existsSync, readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { QueueItem } from "./queue";
import type { TurnRec } from "./usage";

export const WINDOW_MS = 24 * 3_600_000;
/** Turns closer than this merge into one bar: a quick reply is not a break. */
export const MERGE_GAP_MS = 2 * 60_000;
/** A gap in the user's own sessions at least this long is "away". */
export const AWAY_MS = 3_600_000;

/** A stretch of work: start, end, how many turns, how many tool calls. */
export type Span = { s: number; e: number; turns: number; calls: number };

export type Mark =
  | { kind: "asked"; at: number; answeredAt: number | null; title: string; id: string }
  | { kind: "blocked"; at: number; answeredAt: number | null; title: string; id: string }
  | { kind: "finished"; at: number; file: string };

export type Lane = {
  name: string;
  spans: Span[];
  marks: Mark[];
  /** Start of a turn still running in the agent's current session, if its calls show one. */
  openSince: number | null;
  /** The last thing in the window, for ordering. */
  last: number;
};

export type Timeline = {
  start: number;
  end: number;
  lanes: Lane[];
  /** How many agents did nothing in the window. */
  quiet: number;
  /** The user's own sessions, or null when they could not be told apart. */
  you: { spans: Span[] } | null;
  youNote: string | null;
  /** The last gap of an hour or more in the user's sessions, up to now. */
  away: { s: number; e: number } | null;
};

export type AgentSessions = {
  name: string;
  /** Session ids, full or the 8-character short form from log.md. */
  sessions: string[];
  /** The session it runs in now (session.json). */
  current: string | null;
  /** mtimes of its reports/ files, with their names. */
  reports: { file: string; at: number }[];
};

export type TimelineInput = {
  now: number;
  agents: AgentSessions[];
  turns: TurnRec[];
  /** Times of tool calls and model calls, per session: they show a turn still running. */
  activity: { session: string; ts: number }[];
  /** Tool calls, for the count on each bar. */
  calls: { session: string; ts: number }[];
  queue: Pick<QueueItem, "id" | "kind" | "from" | "title" | "created" | "answered">[];
  /** Session ids Claude Code lists as background; null when that list could not be read. */
  background: Set<string> | null;
};

const short = (id: string) => id.slice(0, 8);

/** Merges turns into bars, clipped to the window. Input in any order. */
export function spansOf(turns: { s: number; e: number }[], calls: number[], start: number, end: number): Span[] {
  const sorted = turns
    .map((t) => ({ s: Math.max(start, t.s), e: Math.min(end, t.e) }))
    .filter((t) => t.e > t.s || (t.e === t.s && t.e >= start))
    .sort((a, b) => a.s - b.s);
  const out: Span[] = [];
  for (const t of sorted) {
    const prev = out.at(-1);
    if (prev && t.s - prev.e <= MERGE_GAP_MS) { prev.e = Math.max(prev.e, t.e); prev.turns++; }
    else out.push({ s: t.s, e: t.e, turns: 1, calls: 0 });
  }
  for (const ts of calls) {
    const sp = out.find((x) => ts >= x.s && ts <= x.e);
    if (sp) sp.calls++;
  }
  return out;
}

export function buildTimeline(i: TimelineInput): Timeline {
  const end = i.now;
  const start = end - WINDOW_MS;
  const owner = new Map<string, string>(); // short session id → agent
  for (const a of i.agents) {
    for (const s of a.sessions) owner.set(short(s), a.name);
    if (a.current) owner.set(short(a.current), a.name);
  }
  const ownerOf = (session: string) => owner.get(short(session));

  const turnsBy = new Map<string, { s: number; e: number }[]>();
  const youTurns: { s: number; e: number }[] = [];
  const lastEnd = new Map<string, number>(); // per session, any time in the index
  for (const t of i.turns) {
    lastEnd.set(t.session, Math.max(lastEnd.get(t.session) ?? 0, t.end));
    if (t.end < start) continue;
    const who = ownerOf(t.session);
    const span = { s: t.end - t.ms, e: t.end };
    if (who) (turnsBy.get(who) ?? turnsBy.set(who, []).get(who)!).push(span);
    else if (!t.sdk && i.background && !i.background.has(t.session)) youTurns.push(span);
  }
  const callsBy = new Map<string, number[]>();
  for (const c of i.calls) {
    if (c.ts < start) continue;
    const who = ownerOf(c.session) ?? "";
    (callsBy.get(who) ?? callsBy.set(who, []).get(who)!).push(c.ts);
  }

  const lanes: Lane[] = [];
  let quiet = 0;
  for (const a of i.agents) {
    const spans = spansOf(turnsBy.get(a.name) ?? [], callsBy.get(a.name) ?? [], start, end);
    const marks: Mark[] = [];
    for (const q of i.queue) {
      if (q.from !== a.name) continue;
      const at = Date.parse(q.created);
      if (!(at >= start && at <= end)) continue;
      const answeredAt = q.answered ? Date.parse(q.answered) : NaN;
      marks.push({ kind: q.kind === "blocker" ? "blocked" : "asked", at, answeredAt: Number.isFinite(answeredAt) ? answeredAt : null, title: q.title, id: q.id });
    }
    for (const r of a.reports) if (r.at >= start && r.at <= end) marks.push({ kind: "finished", at: r.at, file: r.file });
    marks.sort((x, y) => x.at - y.at);

    // A turn still running: calls in the current session after its last turn ended.
    let openSince: number | null = null;
    if (a.current) {
      const after = lastEnd.get(a.current) ?? 0;
      for (const x of i.activity) {
        if (x.session === a.current && x.ts > after && x.ts >= start && (openSince === null || x.ts < openSince)) openSince = x.ts;
      }
    }
    if (!spans.length && !marks.length && openSince === null) { quiet++; continue; }
    const last = Math.max(spans.at(-1)?.e ?? 0, marks.at(-1)?.at ?? 0, openSince ?? 0);
    lanes.push({ name: a.name, spans, marks, openSince, last });
  }
  // Maya first, then whoever did something most recently.
  lanes.sort((x, y) => (x.name === "maya" ? -1 : y.name === "maya" ? 1 : y.last - x.last || x.name.localeCompare(y.name)));

  const you = i.background ? { spans: spansOf(youTurns, callsBy.get("") ?? [], start, end) } : null;
  return {
    start,
    end,
    lanes,
    quiet,
    you,
    youNote: i.background ? null : "Your sessions are not shown: Claude Code's list of background sessions could not be read.",
    away: you ? awayOf(you.spans, end) : null,
  };
}

/** The latest gap of at least AWAY_MS in the user's sessions, counting the stretch from the last one to now. */
export function awayOf(spans: Span[], now: number): { s: number; e: number } | null {
  if (!spans.length) return null;
  const gaps: { s: number; e: number }[] = [];
  for (let k = 1; k < spans.length; k++) gaps.push({ s: spans[k - 1]!.e, e: spans[k]!.s });
  gaps.push({ s: spans.at(-1)!.e, e: now });
  for (let k = gaps.length - 1; k >= 0; k--) if (gaps[k]!.e - gaps[k]!.s >= AWAY_MS) return gaps[k]!;
  return null;
}

/** Session ids on log.md's "started by …" and "resumed by …" lines: `(session 1b3b4c82, model opus)`. */
export function logSessions(log: string): string[] {
  return [...log.matchAll(/\(session ([0-9a-f]{8})\b/g)].map((m) => m[1]!);
}

/** Each agent's sessions and reports, from ~/.comb/agents. Read only. */
export async function readAgentLanes(home: string): Promise<AgentSessions[]> {
  const root = join(home, "agents");
  if (!existsSync(root)) return [];
  const out: AgentSessions[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = join(root, e.name);
    if (!existsSync(join(dir, "charter.md"))) continue;
    let current: string | null = null;
    try { current = (JSON.parse(await readFile(join(dir, "session.json"), "utf-8")) as { sessionId?: string }).sessionId ?? null; } catch { /* intentional: no session yet */ }
    let log = "";
    try { log = await readFile(join(dir, "log.md"), "utf-8"); } catch { /* intentional: no log yet */ }
    const reports: { file: string; at: number }[] = [];
    const rdir = join(dir, "reports");
    if (existsSync(rdir)) {
      for (const f of readdirSync(rdir)) {
        if (!f.endsWith(".md")) continue;
        try { reports.push({ file: f, at: (await stat(join(rdir, f))).mtimeMs }); } catch { /* intentional: gone mid-read */ }
      }
    }
    out.push({ name: e.name, sessions: [...new Set([...logSessions(log), ...(current ? [current] : [])])], current, reports });
  }
  return out;
}
