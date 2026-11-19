/**
 * What the page shows at a glance: the agent tree, Greg's own sessions and
 * other sessions, each with its state and what it is doing now. Built from
 * ~/.comb, `claude agents --json`, and the tail of each transcript.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { agentDir, GREG, readAgentSession, type AgentSession } from "../agents";
import { isEnded, type LiveSession } from "../claude";
import { DEFAULT_FOLD_AFTER_HOURS, readCombConfig, userLabel, type UserLabel } from "../config";
import { projectForDir } from "../hive";
import { listItems, type QueueItem } from "../queue";
import { parseLines, settle, transcriptPath, type FeedEvent } from "../transcript";

export type Activity = "working" | "waiting" | "asleep";

/** The latest thing a session did, in one line. */
export type Now = { kind: "tool" | "say" | "in"; text: string; tool?: string; at: string };

/**
 * A Now as the transcript gives it. An "in" line keeps its sender apart from
 * the message; `labelRecent` puts the name in front at snapshot time, so a
 * changed userName shows at once even though tails are cached.
 */
type Line = Now & { from?: string };

export type AgentNode = {
  name: string;
  parent: string;
  about: string | null;
  activity: Activity;
  sessionId: string | null;
  cwd: string | null;
  project: string | null;
  now: Now | null;
  /** The last few things it did, oldest first. */
  recent: Now[];
  /** Its last words, in full (capped), for the page's notes. */
  note: { text: string; at: string } | null;
  /** ISO time of its last message, word, tool call or turn end. */
  lastActive: string | null;
  /** How many files are in its reports/. */
  reports: number;
  /** Folded into the page's Finished group (D22). */
  finished: boolean;
};

export type SessionNode = {
  name: string;
  sessionId: string;
  cwd: string;
  project: string | null;
  kind: "interactive" | "background";
  activity: Activity;
  now: Now | null;
  recent: Now[];
  note: { text: string; at: string } | null;
  lastActive: string | null;
  startedAt: string | null;
  /** Folded into the page's Finished group (D22). */
  finished: boolean;
};

export type Snapshot = {
  at: string;
  /** How the page names the human (id "greg"), from config.json; read each build, so an edit shows up live. */
  user: UserLabel;
  /** hive is on: tickets, memory and `hive attach` (D24). */
  hive: boolean;
  /** config.json's defaultModel: what the queue's picker shows when an item names none (D25). */
  defaultModel: string;
  agents: AgentNode[];
  /** Greg's own interactive sessions. */
  mine: SessionNode[];
  /** Live background sessions that are not comb agents. */
  others: SessionNode[];
  /** Open queue items, then ones answered in the last day. */
  queue: QueueItem[];
  error: string | null;
};

export function activityOf(row: LiveSession | undefined): Activity {
  if (!row || isEnded(row)) return "asleep";
  return row.status === "busy" || row.status === "working" || row.state === "working" ? "working" : "waiting";
}

export type BuildOpts = {
  home: string;
  live: LiveSession[];
  claudeHome?: string;
  liveError?: string | null;
  /** Whether hive is on (detected once at page start). Off by default. */
  hive?: boolean;
  /** hive's home, for project names; only read when hive is on. */
  hiveHome?: string;
};

export async function buildSnapshot(opts: BuildOpts): Promise<Snapshot> {
  const { home, live } = opts;
  const root = join(home, "agents");
  const names = existsSync(root)
    ? readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];
  const bySession = new Map(live.map((s) => [s.sessionId, s]));
  const agentSessions = new Set<string>();

  const config = readCombConfig(home);
  const user = userLabel(config);
  const label = (tail: Tail | null) => (tail ? labelRecent(tail.recent, user) : []);

  const agents: AgentNode[] = [];
  for (const name of names) {
    const dir = agentDir(name, home);
    if (!existsSync(join(dir, "charter.md"))) continue;
    const session: AgentSession | null = await readAgentSession(name, home).catch(() => null);
    const row = session ? bySession.get(session.sessionId) : undefined;
    if (session) agentSessions.add(session.sessionId);
    const tail = session ? await tailNow(transcriptPath(session.cwd, session.sessionId, opts.claudeHome), session.parent, session.cwd) : null;
    const recent = label(tail);
    agents.push({
      name,
      parent: session?.parent ?? GREG,
      about: await about(join(dir, "charter.md")),
      activity: activityOf(row),
      sessionId: session?.sessionId ?? null,
      cwd: session?.cwd ?? null,
      project: session?.project ?? null,
      now: recent.at(-1) ?? null,
      recent,
      note: tail?.note ?? null,
      // Claude Code prunes old transcripts; the log still says when it last acted.
      lastActive: tail?.mtime ?? mtimeOf(join(dir, "log.md")),
      reports: countFiles(join(dir, "reports")),
      finished: false,
    });
  }
  const foldAfter = config.foldAfterHours * HOUR_MS;
  const now = Date.now();
  const folded = foldedAgents(agents, now, foldAfter);
  for (const a of agents) a.finished = folded.has(a.name);

  const mine: SessionNode[] = [];
  const others: SessionNode[] = [];
  for (const row of live) {
    if (agentSessions.has(row.sessionId) || isEnded(row)) continue;
    // An older session that shares an agent's name is that agent's past.
    if (row.kind === "background" && names.includes(row.name)) continue;
    const kind = row.kind === "interactive" ? "interactive" : "background";
    const tail = await tailNow(transcriptPath(row.cwd, row.sessionId, opts.claudeHome), kind === "interactive" ? GREG : "comb", row.cwd);
    const recent = label(tail);
    const node: SessionNode = {
      name: row.name,
      sessionId: row.sessionId,
      cwd: row.cwd,
      project: opts.hive ? projectFor(row.cwd, opts.hiveHome) : null,
      kind,
      activity: activityOf(row),
      now: recent.at(-1) ?? null,
      recent,
      note: tail?.note ?? null,
      lastActive: tail?.mtime ?? null,
      startedAt: typeof (row as any).startedAt === "number" ? new Date((row as any).startedAt).toISOString() : null,
      finished: false,
    };
    if (kind === "interactive") node.finished = sessionFolds({ ...node, ended: isEnded(row) }, now, foldAfter);
    (kind === "interactive" ? mine : others).push(node);
  }
  const recent = (a: SessionNode, b: SessionNode) =>
    (a.activity === "working" ? 0 : 1) - (b.activity === "working" ? 0 : 1) || (b.lastActive ?? "").localeCompare(a.lastActive ?? "");
  mine.sort(recent);
  others.sort(recent);

  const queue = await listItems(home).catch(() => []);
  return {
    at: new Date().toISOString(), user, hive: opts.hive ?? false, defaultModel: config.defaultModel,
    agents, mine, others, queue, error: opts.liveError ?? null,
  };
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * How long a finished agent or Greg's idle session stays in the main list
 * by default: one day. `foldAfterHours` in config.json overrides it.
 */
export const FOLD_AFTER_MS = DEFAULT_FOLD_AFTER_HOURS * HOUR_MS;

const idleFor = (lastActive: string | null, now: number) => {
  const t = lastActive ? Date.parse(lastActive) : NaN;
  return Number.isNaN(t) ? 0 : now - t;
};

/**
 * Which agents fold into the Finished group (D22). An agent folds when it
 * has written a report, is not on a turn, and has done nothing for `after`
 * (FOLD_AFTER_MS unless config.json sets foldAfterHours). Maya never folds, and a parent stays while any child of
 * its stays. Folding hides a row; it deletes nothing.
 */
export function foldedAgents(
  agents: Pick<AgentNode, "name" | "parent" | "activity" | "lastActive" | "reports">[],
  now: number,
  after: number = FOLD_AFTER_MS,
): Set<string> {
  const byName = new Map(agents.map((a) => [a.name, a]));
  const kids = new Map<string, string[]>();
  for (const a of agents) if (a.parent !== a.name) kids.set(a.parent, [...(kids.get(a.parent) ?? []), a.name]);
  const memo = new Map<string, boolean>();
  const folds = (name: string, path: Set<string>): boolean => {
    if (memo.has(name)) return memo.get(name)!;
    const a = byName.get(name)!;
    let ok = a.name !== "maya" && a.reports > 0 && a.activity !== "working" && idleFor(a.lastActive, now) >= after;
    path.add(name);
    for (const k of kids.get(name) ?? []) {
      if (!ok) break;
      if (!path.has(k) && !folds(k, path)) ok = false;
    }
    path.delete(name);
    memo.set(name, ok);
    return ok;
  };
  return new Set(agents.filter((a) => folds(a.name, new Set())).map((a) => a.name));
}

/**
 * Greg's own sessions fold only once their process has ended, then by last
 * activity. An open one never folds: a terminal tab he keeps for weeks is a
 * workspace he comes back to, not finished work (2026-11-17). The rail keeps
 * the list short by showing the six most recent instead.
 */
export function sessionFolds(
  s: Pick<SessionNode, "activity" | "lastActive" | "startedAt"> & { ended: boolean },
  now: number,
  after: number = FOLD_AFTER_MS,
): boolean {
  return s.ended && s.activity !== "working" && idleFor(s.lastActive ?? s.startedAt, now) >= after;
}

function mtimeOf(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null; // intentional: no log yet
  }
}

function countFiles(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith(".")).length;
  } catch {
    return 0; // intentional: no reports folder
  }
}

const projectCache = new Map<string, string | null>();
function projectFor(cwd: string, hiveHome?: string): string | null {
  if (!projectCache.has(cwd)) projectCache.set(cwd, projectForDir(cwd, hiveHome));
  return projectCache.get(cwd)!;
}

async function about(path: string): Promise<string | null> {
  try {
    const line = (await readFile(path, "utf-8")).split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean);
    if (!line) return null;
    return line.length > 120 ? line.slice(0, 119) + "…" : line;
  } catch {
    return null; // intentional: no charter, no description
  }
}

const TAIL_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 16 * 1024 * 1024;

/**
 * The last few things in a transcript, one line each, and when the last of
 * them happened. Not the file's mtime: Claude Code writes bookkeeping lines
 * to an idle session's transcript.
 */
type Tail = { recent: Line[]; note: { text: string; at: string } | null; mtime: string | null };

export async function tailNow(path: string, defaultFrom: string, cwd: string): Promise<Tail | null> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return null; // intentional: a session with no transcript yet
  }
  // Transcripts only grow; an unchanged size means an unchanged answer.
  const cached = tailCache.get(path);
  if (cached && cached.size === size) return cached.result;
  const result = await readTail(path, size, defaultFrom, cwd);
  tailCache.set(path, { size, result });
  return result;
}

const tailCache = new Map<string, { size: number; result: Tail }>();

async function readTail(path: string, size: number, defaultFrom: string, cwd: string): Promise<Tail> {
  // Screenshots and big tool results can fill the last few hundred KB, so
  // read further back until something worth a line turns up.
  const fh = await open(path, "r");
  try {
    for (let bytes = TAIL_BYTES; ; bytes *= 4) {
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      const lines = buf.toString("utf-8").split("\n");
      if (start > 0) lines.shift(); // the first line is cut
      const events = settle(parseLines(lines, defaultFrom, cwd));
      const recent = recentOf(events, 4);
      if (recent.length >= 4 || start === 0 || bytes >= MAX_TAIL_BYTES) {
        const last = events.findLast((e) => e.k !== "done" && e.at);
        const say = events.findLast((e) => e.k === "say");
        const note = say && say.k === "say" ? { text: say.text.length > 900 ? say.text.slice(0, 899) + "…" : say.text, at: say.at } : null;
        return { recent, note, mtime: last && last.k !== "done" ? last.at : null };
      }
    }
  } finally {
    await fh.close();
  }
}

/** The last `n` events worth a line, oldest first. */
export function recentOf(events: FeedEvent[], n: number): Line[] {
  const out: Line[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < n; i--) {
    const e = events[i]!;
    if (e.k === "tool") out.push({ kind: "tool", tool: e.name, text: e.detail, at: e.at });
    else if (e.k === "say") out.push({ kind: "say", text: firstLine(e.text), at: e.at });
    else if (e.k === "in") out.push({ kind: "in", from: e.from, text: firstLine(e.text), at: e.at });
  }
  return out.reverse();
}

/** Puts each "in" line's sender in front of it, with the user's own name for theirs. */
export function labelRecent(lines: Line[], user: UserLabel): Now[] {
  return lines.map(({ from, ...now }) =>
    from === undefined ? now : { ...now, text: `${from === GREG ? user.name : from}: ${now.text}` });
}

function firstLine(s: string): string {
  const line = s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const plain = line.replace(/\*\*|`|^#+\s*|^>\s*/g, "");
  return plain.length > 140 ? plain.slice(0, 139) + "…" : plain;
}
