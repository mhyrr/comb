/**
 * Token usage across the AI coding harnesses on this machine, for the usage
 * panel on the page's Now tab. Read only, and counts only: no message text
 * leaves the parsers.
 *
 * What it reads:
 *   Claude Code  ~/.claude/projects/**\/*.jsonl  assistant `message.usage`, deduped by message id
 *   Codex CLI    ~/.codex/sessions/**\/*.jsonl   `token_count` events; cumulative totals, so deltas
 *   Gemini CLI   ~/.gemini/tmp/*\/chats/*.json   per-message `tokens`
 *   Cursor       ~/.cursor, Cursor's app data    no token counts are kept locally; reported as such
 *
 * Transcripts are append-only, so each file is read from where the last read
 * stopped. The per-file results persist in ~/.comb/cache/usage.json, keyed by
 * path, mtime and size, so a restart re-reads only what changed.
 */
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { priceOf, PRICING_SOURCE, rateFor } from "./pricing";

export type HarnessId = "claude" | "codex" | "gemini" | "cursor";

/** One model call's tokens. Input is uncached input only; read and writes are the cache's slices. */
export type Rec = {
  /** Dedupe key, unique within a harness. */
  id: string;
  ts: number;
  model: string;
  session: string;
  input: number;
  write5m: number;
  write1h: number;
  read: number;
  /** Output, reasoning or thinking included. */
  output: number;
  /** The part of output spent thinking, when the harness says. */
  thinking: number;
  /** Claude fast mode: a different price, so left unpriced. */
  fast?: boolean;
};

export type Roots = {
  claude: string;
  codex: string;
  gemini: string;
  /** Any of these existing means Cursor is installed. */
  cursor: string[];
};

export function defaultRoots(home = homedir()): Roots {
  return {
    claude: join(home, ".claude", "projects"),
    codex: join(home, ".codex", "sessions"),
    gemini: join(home, ".gemini", "tmp"),
    cursor: [join(home, ".cursor"), join(home, "Library", "Application Support", "Cursor")],
  };
}

const DAY = 86_400_000;
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

// ---------------------------------------------------------------- parsers

/** A Claude Code transcript line to a usage record, or null for anything else. */
export function parseClaudeLine(line: string, fallbackSession: string): Rec | null {
  return parseClaude(line, fallbackSession).rec;
}

/**
 * A finished turn: the `system` line with subtype `turn_duration` that Claude
 * Code writes at each turn's end. The turn ran from end − ms to end. The id
 * is the line's uuid, which a resumed session's copy keeps.
 */
export type TurnRec = { id: string; session: string; end: number; ms: number };

/**
 * One tool call: a `tool_use` block. Only its id, time, session and name are
 * kept, never its input. `cli` is the first word of a Bash command, kept only
 * when it is on CLI_WORDS, so the tools panel can count `gh` beside the MCP
 * servers (design doc 2026-11-17, decision 6).
 */
export type ToolRec = { id: string; ts: number; session: string; name: string; cli?: string };

/** The command-line tools whose Bash calls are counted by name. Nothing else of a command is read. */
export const CLI_WORDS = ["gh"] as const;

/** The first word of a shell command, after any leading VAR=value assignments, if it is on CLI_WORDS. */
export function cliWord(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  const words = command.trimStart().split(/\s+/, 8);
  const first = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  return first && (CLI_WORDS as readonly string[]).includes(first) ? first : undefined;
}

/** Everything the index keeps from one Claude Code line: usage, a turn's end, tool calls. One JSON parse. */
export function parseClaude(line: string, fallbackSession: string): { rec: Rec | null; turn: TurnRec | null; tools: ToolRec[] } {
  const none = { rec: null, turn: null, tools: [] };
  const usage = line.includes('"usage"');
  // Exact compact keys: every tool result line holds "tool_use_id", and those can be megabytes.
  const turn = line.includes('"subtype":"turn_duration"');
  const tool = line.includes('"type":"tool_use"');
  if (!usage && !turn && !tool) return none;
  let o: any;
  try { o = JSON.parse(line); } catch { throw new BadLine(); }
  const session = typeof o?.sessionId === "string" ? o.sessionId : fallbackSession;
  const ts = Date.parse(o?.timestamp);
  if (!Number.isFinite(ts)) return none;
  if (o?.type === "system") {
    // A sub-agent's turn happens inside its parent's turn; only the parent's counts.
    if (o.subtype !== "turn_duration" || o.isSidechain || !(typeof o.durationMs === "number" && o.durationMs >= 0)) return none;
    return { rec: null, turn: { id: String(o.uuid ?? `${session}:${ts}`), session, end: ts, ms: o.durationMs }, tools: [] };
  }
  if (o?.type !== "assistant") return none;
  const tools: ToolRec[] = [];
  for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
    if (b?.type !== "tool_use" || typeof b.id !== "string" || typeof b.name !== "string") continue;
    const cli = b.name === "Bash" ? cliWord(b.input?.command) : undefined;
    tools.push({ id: b.id, ts, session, name: b.name, ...(cli ? { cli } : {}) });
  }
  return { rec: usage ? usageOf(o, ts, session) : null, turn: null, tools };
}

function usageOf(o: any, ts: number, session: string): Rec | null {
  const m = o.message;
  const u = m?.usage;
  const model = typeof m?.model === "string" ? m.model : "";
  if (!u || !model || model === "<synthetic>") return null;
  const write = n(u.cache_creation_input_tokens);
  const write1h = Math.min(write, n(u.cache_creation?.ephemeral_1h_input_tokens));
  return {
    id: String(m.id ?? o.requestId ?? o.uuid),
    ts,
    model,
    session,
    input: n(u.input_tokens),
    write5m: write - write1h,
    write1h,
    read: n(u.cache_read_input_tokens),
    output: n(u.output_tokens),
    thinking: n(u.output_tokens_details?.thinking_tokens),
    ...(u.speed === "fast" ? { fast: true } : {}),
  };
}

/** What a Codex file's earlier lines left behind: its session, model and running totals. */
export type CodexState = { session: string; model: string; input: number; cached: number; output: number; reasoning: number; total: number };

export const codexStart = (session: string): CodexState =>
  ({ session, model: "", input: 0, cached: 0, output: 0, reasoning: 0, total: 0 });

/**
 * A Codex rollout line. `token_count` events carry cumulative totals and can
 * repeat, so each record is the step since the last total, keyed by session
 * and total so a resumed copy of the same events is not counted twice.
 */
export function parseCodexLine(line: string, st: CodexState): Rec | null {
  const kind = line.includes('"token_count"') ? "tokens" : line.includes('"turn_context"') ? "turn" : line.includes('"session_meta"') ? "meta" : null;
  if (!kind) return null;
  let o: any;
  try { o = JSON.parse(line); } catch { throw new BadLine(); }
  const p = o?.payload;
  if (kind === "meta" && o.type === "session_meta" && typeof p?.id === "string") { st.session = p.id; return null; }
  if (kind === "turn" && o.type === "turn_context" && typeof p?.model === "string") { st.model = p.model; return null; }
  if (kind !== "tokens" || p?.type !== "token_count") return null;
  const t = p.info?.total_token_usage;
  if (!t) return null;
  const total = n(t.total_tokens);
  if (total <= st.total) return null;
  const d = {
    input: Math.max(0, n(t.input_tokens) - st.input),
    cached: Math.max(0, n(t.cached_input_tokens) - st.cached),
    output: Math.max(0, n(t.output_tokens) - st.output),
    reasoning: Math.max(0, n(t.reasoning_output_tokens) - st.reasoning),
  };
  Object.assign(st, { input: n(t.input_tokens), cached: n(t.cached_input_tokens), output: n(t.output_tokens), reasoning: n(t.reasoning_output_tokens), total });
  const ts = Date.parse(o.timestamp);
  if (!Number.isFinite(ts)) return null;
  return {
    id: `${st.session}:${total}`,
    ts,
    model: st.model || "codex",
    session: st.session,
    // Codex counts cached input inside input_tokens.
    input: Math.max(0, d.input - d.cached),
    write5m: 0,
    write1h: 0,
    read: d.cached,
    output: d.output,
    thinking: d.reasoning,
  };
}

/** A Gemini CLI chat file (one JSON document, rewritten whole). Throws when it is not JSON. */
export function parseGeminiChat(text: string, fallbackSession: string): Rec[] {
  const d = JSON.parse(text);
  const session = typeof d?.sessionId === "string" ? d.sessionId : fallbackSession;
  const out: Rec[] = [];
  for (const m of Array.isArray(d?.messages) ? d.messages : []) {
    const t = m?.tokens;
    const ts = Date.parse(m?.timestamp);
    if (!t || !Number.isFinite(ts)) continue;
    const cached = n(t.cached);
    out.push({
      id: `${session}:${m.id ?? ts}`,
      ts,
      model: typeof m.model === "string" ? m.model : "gemini",
      session,
      input: Math.max(0, n(t.input) - cached),
      write5m: 0,
      write1h: 0,
      read: cached,
      // Gemini reports thoughts beside output, not inside it.
      output: n(t.output) + n(t.thoughts),
      thinking: n(t.thoughts),
    });
  }
  return out;
}

class BadLine extends Error {}

// ---------------------------------------------------------------- the index

type Entry = {
  harness: HarnessId;
  mtimeMs: number;
  size: number;
  /** Bytes read so far: always the end of the last complete line. */
  offset: number;
  recs: Rec[];
  /** Claude Code only: finished turns and tool calls, kept for ACTIVITY_DAYS. */
  turns?: TurnRec[];
  tools?: ToolRec[];
  /** The newest record ever seen in the file, kept after old records are pruned. */
  lastTs: number;
  /** Lines that were not JSON. */
  bad: number;
  codex?: CodexState;
};

/** 2 (2026-11-19): turns and tool calls. A version-1 cache is dropped, which costs one full re-read. */
const CACHE_VERSION = 2;
/** Turns and tool calls are kept this long: the tools panel's 7 days plus a day of slack. */
export const ACTIVITY_DAYS = 8;
const CHUNK = 8 * 1024 * 1024;

export type UsageOpts = {
  roots?: Roots;
  /** Where the per-file cache persists; null keeps it in memory only. */
  cachePath?: string | null;
  /** Days of history the panel shows. Older records are dropped. */
  windowDays?: number;
  now?: () => number;
};

export class UsageIndex {
  readonly roots: Roots;
  readonly cachePath: string | null;
  readonly windowDays: number;
  private now: () => number;
  private entries = new Map<string, Entry>();
  private loaded = false;
  /** Per harness: why its files could not be listed, when they could not. */
  private problems = new Map<HarnessId, string>();
  /** Files read on the last refresh, for tests and logs. */
  lastRead: string[] = [];
  ready = false;

  constructor(opts: UsageOpts = {}) {
    this.roots = opts.roots ?? defaultRoots();
    this.cachePath = opts.cachePath === undefined ? null : opts.cachePath;
    this.windowDays = opts.windowDays ?? 30;
    this.now = opts.now ?? Date.now;
  }

  /** Records older than this are not kept: the window plus a day of slack for time zones. */
  private horizon(): number {
    return this.now() - (this.windowDays + 1) * DAY;
  }

  private activityHorizon(): number {
    return this.now() - ACTIVITY_DAYS * DAY;
  }

  async refresh(): Promise<void> {
    if (!this.loaded) await this.load();
    const horizon = this.horizon();
    const seen = new Set<string>();
    this.lastRead = [];
    this.problems.clear();
    const lists: [HarnessId, Promise<string[]>][] = [
      ["claude", listFiles(this.roots.claude, (f) => f.endsWith(".jsonl"))],
      ["codex", listFiles(this.roots.codex, (f) => f.endsWith(".jsonl"))],
      ["gemini", listFiles(this.roots.gemini, (f, dir) => f.endsWith(".json") && dir.endsWith("/chats"))],
    ];
    for (const [harness, list] of lists) {
      let files: string[];
      try {
        files = await list;
      } catch (err) {
        this.problems.set(harness, err instanceof Error ? err.message : String(err));
        continue;
      }
      for (const path of files) {
        let st;
        try { st = await stat(path); } catch { continue; }
        // A file untouched since before the window holds nothing in it. Gemini's
        // few small files are kept anyway, so the panel can say when it was last used.
        if (st.mtimeMs < horizon && harness !== "gemini") continue;
        seen.add(path);
        const old = this.entries.get(path);
        if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) continue;
        try {
          this.entries.set(path, await this.read(harness, path, st.size, st.mtimeMs, old));
          this.lastRead.push(path);
        } catch {
          // Unreadable now (permissions, mid-rotation): keep what we had, try again next time.
        }
      }
    }
    let changed = this.lastRead.length > 0;
    const recent = this.activityHorizon();
    for (const [path, e] of this.entries) {
      if (!seen.has(path)) { this.entries.delete(path); changed = true; continue; }
      if (e.recs.some((r) => r.ts < horizon)) { e.recs = e.recs.filter((r) => r.ts >= horizon); changed = true; }
      if (e.turns?.some((t) => t.end < recent)) { e.turns = e.turns.filter((t) => t.end >= recent); changed = true; }
      if (e.tools?.some((t) => t.ts < recent)) { e.tools = e.tools.filter((t) => t.ts >= recent); changed = true; }
    }
    this.ready = true;
    if (changed) await this.save();
  }

  private async read(harness: HarnessId, path: string, size: number, mtimeMs: number, old: Entry | undefined): Promise<Entry> {
    const horizon = this.horizon();
    const recent = this.activityHorizon();
    const base = path.split("/").at(-1)!.replace(/\.jsonl?$/, "");
    if (harness === "gemini") {
      const e: Entry = { harness, mtimeMs, size, offset: size, recs: [], lastTs: 0, bad: 0 };
      try {
        const recs = parseGeminiChat(await readFile(path, "utf-8"), base);
        e.lastTs = recs.reduce((m, r) => Math.max(m, r.ts), 0);
        e.recs = recs.filter((r) => r.ts >= horizon);
      } catch {
        e.bad = 1;
      }
      return e;
    }
    // Append-only: carry on from the last complete line, unless the file shrank (rewritten).
    const resume = old && old.harness === harness && size >= old.offset && old.offset > 0;
    const e: Entry = resume
      ? { ...old, mtimeMs, size, recs: [...old.recs], codex: old.codex && { ...old.codex }, ...(harness === "claude" ? { turns: [...(old.turns ?? [])], tools: [...(old.tools ?? [])] } : {}) }
      : { harness, mtimeMs, size, offset: 0, recs: [], lastTs: 0, bad: 0, ...(harness === "codex" ? { codex: codexStart(base) } : {}), ...(harness === "claude" ? { turns: [], tools: [] } : {}) };
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(Math.min(CHUNK, Math.max(1, size - e.offset)));
      let pos = e.offset;
      let carry = "";
      while (pos < size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
        if (!bytesRead) break;
        pos += bytesRead;
        const text = carry + buf.toString("utf-8", 0, bytesRead);
        const cut = text.lastIndexOf("\n");
        if (cut < 0) { carry = text; continue; }
        carry = text.slice(cut + 1);
        for (const line of text.slice(0, cut).split("\n")) {
          if (!line) continue;
          let rec: Rec | null;
          try {
            if (harness === "claude") {
              const got = parseClaude(line, base);
              rec = got.rec;
              if (got.turn && got.turn.end >= recent) e.turns!.push(got.turn);
              for (const t of got.tools) if (t.ts >= recent) e.tools!.push(t);
            } else {
              rec = parseCodexLine(line, e.codex!);
            }
          } catch {
            e.bad++;
            continue;
          }
          if (!rec) continue;
          if (rec.ts > e.lastTs) e.lastTs = rec.ts;
          if (rec.ts >= horizon) e.recs.push(rec);
        }
      }
      // The tail without a newline may still be being written: read it next time.
      e.offset = pos - Buffer.byteLength(carry, "utf-8");
    } finally {
      await fh.close();
    }
    return e;
  }

  private async load(): Promise<void> {
    this.loaded = true;
    if (!this.cachePath || !existsSync(this.cachePath)) return;
    try {
      const d = JSON.parse(await readFile(this.cachePath, "utf-8"));
      if (d?.v !== CACHE_VERSION || typeof d.entries !== "object") return;
      for (const [path, e] of Object.entries<any>(d.entries)) {
        this.entries.set(path, {
          ...e,
          recs: (e.recs as unknown[][]).map(unpack),
          ...(e.turns ? { turns: (e.turns as unknown[][]).map(unpackTurn) } : {}),
          ...(e.tools ? { tools: (e.tools as unknown[][]).map(unpackTool) } : {}),
        });
      }
    } catch {
      // A broken cache costs one full re-read, nothing more.
      this.entries.clear();
    }
  }

  private async save(): Promise<void> {
    if (!this.cachePath) return;
    const entries: Record<string, unknown> = {};
    for (const [path, e] of this.entries) {
      entries[path] = {
        ...e,
        recs: e.recs.map(pack),
        ...(e.turns ? { turns: e.turns.map(packTurn) } : {}),
        ...(e.tools ? { tools: e.tools.map(packTool) } : {}),
      };
    }
    await mkdir(dirname(this.cachePath), { recursive: true });
    const tmp = `${this.cachePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ v: CACHE_VERSION, entries }));
    await rename(tmp, this.cachePath);
  }

  /**
   * Claude Code's finished turns in the last ACTIVITY_DAYS, oldest first, each
   * once. A resumed session copies earlier lines into its own file with its
   * own session id; both sessions belong to the same agent, so whichever copy
   * is kept, the agent's turns are the same.
   */
  turns(): TurnRec[] {
    const byId = new Map<string, TurnRec>();
    for (const e of this.entries.values()) for (const t of e.turns ?? []) if (!byId.has(t.id)) byId.set(t.id, t);
    return [...byId.values()].sort((a, b) => a.end - b.end);
  }

  /** Claude Code's tool calls in the last ACTIVITY_DAYS, oldest first, each once (by tool-use id). */
  toolCalls(): ToolRec[] {
    const byId = new Map<string, ToolRec>();
    for (const e of this.entries.values()) for (const t of e.tools ?? []) if (!byId.has(t.id)) byId.set(t.id, t);
    return [...byId.values()].sort((a, b) => a.ts - b.ts);
  }

  /** Every kept record of a harness, each model call once. */
  records(harness: HarnessId): Rec[] {
    const byId = new Map<string, Rec>();
    for (const e of this.entries.values()) {
      if (e.harness !== harness) continue;
      for (const r of e.recs) if (!byId.has(r.id)) byId.set(r.id, r);
    }
    return [...byId.values()];
  }

  summary(): UsageSummary {
    return summarize({
      now: this.now(),
      windowDays: this.windowDays,
      ready: this.ready,
      records: (h) => this.records(h),
      lastTs: (h) => Math.max(0, ...[...this.entries.values()].filter((e) => e.harness === h).map((e) => e.lastTs)),
      badLines: (h) => [...this.entries.values()].filter((e) => e.harness === h).reduce((s, e) => s + e.bad, 0),
      present: (h) => h === "cursor" ? this.roots.cursor.some((p) => existsSync(p)) : existsSync(this.roots[h]),
      problem: (h) => this.problems.get(h) ?? null,
    });
  }
}

const packTurn = (t: TurnRec): unknown[] => [t.id, t.session, t.end, t.ms];
const unpackTurn = (a: unknown[]): TurnRec => {
  const [id, session, end, ms] = a as [string, string, number, number];
  return { id, session, end, ms };
};
const packTool = (t: ToolRec): unknown[] => (t.cli ? [t.id, t.ts, t.session, t.name, t.cli] : [t.id, t.ts, t.session, t.name]);
const unpackTool = (a: unknown[]): ToolRec => {
  const [id, ts, session, name, cli] = a as [string, number, string, string, string | undefined];
  return { id, ts, session, name, ...(cli ? { cli } : {}) };
};
const pack = (r: Rec): unknown[] => [r.id, r.ts, r.model, r.session, r.input, r.write5m, r.write1h, r.read, r.output, r.thinking, r.fast ? 1 : 0];
const unpack = (a: unknown[]): Rec => {
  const [id, ts, model, session, input, write5m, write1h, read, output, thinking, fast] = a as [string, number, string, string, number, number, number, number, number, number, number];
  return { id, ts, model, session, input, write5m, write1h, read, output, thinking, ...(fast ? { fast: true } : {}) };
};

async function listFiles(root: string, keep: (name: string, dir: string) => boolean): Promise<string[]> {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    let items;
    try { items = await readdir(dir, { withFileTypes: true }); } catch (err) {
      if (dir === root) throw err;
      return;
    }
    for (const it of items) {
      const p = join(dir, it.name);
      if (it.isDirectory()) { if (depth < 6) await walk(p, depth + 1); }
      else if (it.isFile() && keep(it.name, dir)) out.push(p);
    }
  };
  await walk(root, 0);
  return out;
}

// ---------------------------------------------------------------- summary

export type Totals = {
  input: number;
  write: number;
  read: number;
  output: number;
  thinking: number;
  /** All four kinds together. */
  tokens: number;
  calls: number;
  sessions: number;
  /** API-equivalent USD over the priced calls; null when none could be priced. */
  usd: number | null;
  /** Output tokens from calls with no trusted price, left out of usd. */
  unpricedOutput: number;
};

export type ModelShare = { model: string; output: number; tokens: number; usd: number | null };

export type HarnessRow = {
  id: HarnessId;
  name: string;
  /** ok: token counts read. none: installed, keeps no counts locally. unreadable: could not read. missing: not installed. */
  status: "ok" | "none" | "unreadable" | "missing";
  note: string | null;
  /** Over the window: output tokens (reasoning included), sessions, calls. */
  output: number;
  tokens: number;
  sessions: number;
  /** The newest record ever seen, even if older than the window. */
  lastAt: string | null;
};

export type UsageSummary = {
  at: string;
  ready: boolean;
  windowDays: number;
  claude: {
    today: Totals;
    week: Totals;
    /** Oldest first, one per local day, the last is today. */
    days: { date: string; output: number; tokens: number; usd: number | null }[];
    /** Last 7 days, biggest output first. */
    models: ModelShare[];
  };
  harnesses: HarnessRow[];
  pricing: typeof PRICING_SOURCE;
};

/** Local calendar day, YYYY-MM-DD. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function usdOf(r: Rec): number | null {
  if (r.fast) return null;
  const rate = rateFor(r.model);
  return rate ? priceOf(r, rate) : null;
}

export function totals(recs: Rec[]): Totals {
  const t: Totals = { input: 0, write: 0, read: 0, output: 0, thinking: 0, tokens: 0, calls: 0, sessions: 0, usd: null, unpricedOutput: 0 };
  const sessions = new Set<string>();
  for (const r of recs) {
    t.input += r.input;
    t.write += r.write5m + r.write1h;
    t.read += r.read;
    t.output += r.output;
    t.thinking += r.thinking;
    t.calls++;
    sessions.add(r.session);
    const usd = usdOf(r);
    if (usd === null) t.unpricedOutput += r.output;
    else t.usd = (t.usd ?? 0) + usd;
  }
  t.tokens = t.input + t.write + t.read + t.output;
  t.sessions = sessions.size;
  return t;
}

const NAMES: Record<HarnessId, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", cursor: "Cursor" };

export function summarize(src: {
  now: number;
  windowDays: number;
  ready: boolean;
  records: (h: HarnessId) => Rec[];
  lastTs: (h: HarnessId) => number;
  badLines: (h: HarnessId) => number;
  present: (h: HarnessId) => boolean;
  problem: (h: HarnessId) => string | null;
}): UsageSummary {
  const today0 = startOfDay(src.now);
  const week0 = startOfDay(today0 - 6 * DAY + DAY / 2);
  const window0 = startOfDay(today0 - (src.windowDays - 1) * DAY + DAY / 2);
  const claude = src.records("claude").filter((r) => r.ts >= window0 && r.ts <= src.now + DAY);

  const byDay = new Map<string, Rec[]>();
  for (const r of claude) {
    const k = dayKey(r.ts);
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(r);
  }
  const days: UsageSummary["claude"]["days"] = [];
  for (let i = src.windowDays - 1; i >= 0; i--) {
    // Step by calendar day at noon, so daylight saving never skips or repeats a day.
    const d = new Date(today0);
    d.setDate(d.getDate() - i);
    d.setHours(12);
    const t = totals(byDay.get(dayKey(d.getTime())) ?? []);
    days.push({ date: dayKey(d.getTime()), output: t.output, tokens: t.tokens, usd: t.usd });
  }

  const week = claude.filter((r) => r.ts >= week0);
  const byModel = new Map<string, Rec[]>();
  for (const r of week) {
    const m = r.model.replace(/\[1m\]$/, "");
    (byModel.get(m) ?? byModel.set(m, []).get(m)!).push(r);
  }
  const models = [...byModel].map(([model, rs]) => {
    const t = totals(rs);
    return { model, output: t.output, tokens: t.tokens, usd: t.unpricedOutput ? null : t.usd };
  }).sort((a, b) => b.output - a.output);

  const harnesses: HarnessRow[] = (["claude", "codex", "gemini", "cursor"] as HarnessId[]).map((id) => {
    const name = NAMES[id];
    if (!src.present(id)) return { id, name, status: "missing", note: null, output: 0, tokens: 0, sessions: 0, lastAt: null };
    if (id === "cursor") {
      return { id, name, status: "none", note: "Installed, but keeps no token counts on this machine.", output: 0, tokens: 0, sessions: 0, lastAt: null };
    }
    const problem = src.problem(id);
    if (problem) return { id, name, status: "unreadable", note: `Could not read its files: ${problem}`, output: 0, tokens: 0, sessions: 0, lastAt: null };
    const t = totals(src.records(id).filter((r) => r.ts >= window0));
    const last = src.lastTs(id);
    const bad = src.badLines(id);
    return {
      id,
      name,
      status: "ok",
      note: bad ? `${bad} unreadable ${bad === 1 ? "line" : "lines"} skipped.` : null,
      output: t.output,
      tokens: t.tokens,
      sessions: t.sessions,
      lastAt: last ? new Date(last).toISOString() : null,
    };
  });

  return {
    at: new Date(src.now).toISOString(),
    ready: src.ready,
    windowDays: src.windowDays,
    claude: { today: totals(claude.filter((r) => r.ts >= today0)), week: totals(week), days, models },
    harnesses,
    pricing: PRICING_SOURCE,
  };
}
