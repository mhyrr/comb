/**
 * MCP server health for Now's tools panel (design doc
 * docs/design/2026-11-17-now-dashboard.md §4.3, decision 7a), from the log
 * Claude Code writes each time a session connects to a server:
 *
 *   ~/Library/Caches/claude-cli-nodejs/<project>/mcp-logs-<server>/<ISO time>.jsonl   (macOS)
 *   ~/.cache/claude-cli-nodejs/...                                                   (Linux)
 *
 * Each line is JSON with `debug` or `error` text. A connect ends in
 * "Successfully connected …" or "Connection failed (<code>): …". A file can
 * hold retries, so the last of those lines in the newest file is the server's
 * state. Read only; nothing is spawned or connected, and no credential is
 * touched. The format is not documented, so this module is the one place that
 * knows it, and it says so when it finds no logs at all.
 *
 * Only a short reason ("400 · bad Authorization header", "refused") reaches the
 * page, never the raw message, which can hold URLs.
 */
import { existsSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const defaultMcpLogRoots = (home = homedir()): string[] => [
  join(home, "Library", "Caches", "claude-cli-nodejs"),
  join(home, ".cache", "claude-cli-nodejs"),
];

/** A log older than this says nothing about now. */
export const HEALTH_FRESH_MS = 2 * 86_400_000;
/** How many older logs to look back through for when a failure began. A server can log a thousand connects in two days. */
const SINCE_LOOKBACK = 400;
/** Only the tail of a log is read: the outcome is near the end, and some logs grow long. */
const TAIL_BYTES = 16 * 1024;

/**
 * A connect's outcome. `signin`: the server wants a login nobody has given
 * ("Authentication required"), which is a setup state, not a failure.
 */
export type Outcome = { ok: true } | { ok: false; signin: true } | { ok: false; signin?: false; code: string; reason: string };

export type ServerHealth = {
  /** The key tool names use: `mcp__<key>__tool`, lowercased (see serverKey). */
  key: string;
  /** What the page calls it: "github", "Dealsplit", "reflect-notes". */
  name: string;
  state: "ok" | "failing" | "signin" | "unknown";
  /** For failing: the short reason. */
  reason: string | null;
  /** For failing: the oldest log in an unbroken run of failures, ISO. */
  since: string | null;
  /** The run of failures reaches past the logs looked at, so it began before `since`. */
  sinceAtLeast: boolean;
  /** When the newest log was written, ISO. */
  checkedAt: string;
};

export type HealthReport = { servers: ServerHealth[]; note: string | null };

/** The key a server's tools and its log folder share: "plugin-github-github" and "plugin_github_github" are one server. */
export function serverKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

/** The name the page shows, from the log folder: plugin-<plugin>-<server> → server; claude-ai-Google-Drive → Google Drive. */
export function displayName(dir: string): string {
  const plugin = dir.match(/^plugin-[^-]+-(.+)$/);
  if (plugin) return plugin[1]!;
  const ai = dir.match(/^claude-ai-(.+)$/);
  if (ai) return ai[1]!.replace(/-/g, " ");
  return dir;
}

/** A short reason for a failure code, without the raw message. */
export function reasonOf(code: string, message: string): string {
  const n = Number(code);
  if (Number.isFinite(n)) {
    if (n === 400) return /authorization header/i.test(message) ? "400 · bad Authorization header" : "400 · bad request";
    if (n === 401) return "401 · needs sign-in";
    if (n === 403) return "403 · forbidden";
    if (n === 404) return "404 · not found";
    if (n === 429) return "429 · rate limited";
    if (n === 502) return "502 · bad gateway";
    if (n === 503) return "503 · unavailable";
    if (n === 504) return "504 · gateway timeout";
    if (n >= 500) return `${n} · server error`;
    return String(n);
  }
  const c = code.toUpperCase();
  if (c === "ECONNREFUSED") return "refused";
  if (c === "ETIMEDOUT" || /timed? ?out/i.test(code)) return "timed out";
  if (c === "ENOTFOUND") return "host not found";
  if (c === "ECONNRESET") return "connection reset";
  return code.slice(0, 40);
}

/** The last connect outcome in a log's lines, or null when there is none. */
export function outcomeOf(text: string): Outcome | null {
  let last: Outcome | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes("Successfully connected") && !line.includes("Connection failed (") && !line.includes("Authentication required")) continue;
    let o: { debug?: unknown; error?: unknown };
    try { o = JSON.parse(line); } catch { continue; } // the first line of a tail read is often cut
    const msg = typeof o.error === "string" ? o.error : typeof o.debug === "string" ? o.debug : "";
    if (msg.startsWith("Successfully connected")) { last = { ok: true }; continue; }
    if (msg.startsWith("Authentication required")) { last = { ok: false, signin: true }; continue; }
    // Only the error line's own wording counts; debug lines repeat it with timings.
    const m = typeof o.error === "string" ? o.error.match(/^Connection failed \(([^)]+)\):\s*([\s\S]*)$/) : null;
    if (m) last = { ok: false, code: m[1]!, reason: reasonOf(m[1]!, m[2]!) };
  }
  return last;
}

async function readTail(path: string): Promise<string> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString("utf-8");
  } finally {
    await fh.close();
  }
}

/** The log file name is the connect time: 2026-11-20T21-57-18-616Z.jsonl. */
export function fileTime(file: string): number {
  const m = file.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.jsonl$/);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN;
}

/**
 * Reads health, keeping each finished log's outcome: a log is written once,
 * when its session connects, so only new files are read on the next call.
 */
export class McpHealth {
  private outcomes = new Map<string, Outcome | null>();
  constructor(private opts: { roots?: string[] } = {}) {}

  private async outcome(path: string, newest: boolean): Promise<Outcome | null> {
    if (!newest && this.outcomes.has(path)) return this.outcomes.get(path)!;
    let out: Outcome | null;
    try { out = outcomeOf(await readTail(path)); } catch { out = null; }
    // The newest log may still be mid-connect: read it again next time.
    if (!newest) this.outcomes.set(path, out);
    return out;
  }

  /** Every server's state from its newest log, across all projects. Never throws: no logs is a note. */
  async read(now = Date.now()): Promise<HealthReport> {
    const roots = (this.opts.roots ?? defaultMcpLogRoots()).filter((r) => existsSync(r));
    const missing = { servers: [], note: "Health unknown: Claude Code's MCP logs were not found." };
    if (!roots.length) return missing;
    // server folder name → its log files, newest first, across every project folder
    const logs = new Map<string, { path: string; at: number }[]>();
    for (const root of roots) {
      let projects: string[];
      try { projects = await readdir(root); } catch { continue; }
      for (const p of projects) {
        let dirs: string[];
        try { dirs = (await readdir(join(root, p))).filter((d) => d.startsWith("mcp-logs-")); } catch { continue; }
        for (const d of dirs) {
          let files: string[];
          try { files = await readdir(join(root, p, d)); } catch { continue; }
          const server = d.slice("mcp-logs-".length);
          const list = logs.get(server) ?? logs.set(server, []).get(server)!;
          for (const f of files) {
            const at = fileTime(f);
            if (Number.isFinite(at)) list.push({ path: join(root, p, d, f), at });
          }
        }
      }
    }
    if (!logs.size) return missing;

    const servers: ServerHealth[] = [];
    for (const [dir, files] of logs) {
      files.sort((a, b) => b.at - a.at);
      const newest = files[0];
      if (!newest || now - newest.at > HEALTH_FRESH_MS) continue; // nothing recent to say
      const base = { key: serverKey(dir), name: displayName(dir), checkedAt: new Date(newest.at).toISOString(), since: null, sinceAtLeast: false, reason: null };
      const first = await this.outcome(newest.path, true);
      if (!first) { servers.push({ ...base, state: "unknown" }); continue; }
      if (first.ok) { servers.push({ ...base, state: "ok" }); continue; }
      if (first.signin) { servers.push({ ...base, state: "signin", reason: "needs sign-in" }); continue; }
      // How long has it failed: back through older logs until one connected.
      let since = newest.at;
      let broke = false;
      for (const f of files.slice(1, SINCE_LOOKBACK)) {
        const out = await this.outcome(f.path, false);
        if (!out) continue; // a log that never got to an outcome says nothing either way
        if (out.ok) { broke = true; break; }
        since = f.at;
      }
      const atLeast = !broke && files.length > SINCE_LOOKBACK;
      servers.push({ ...base, state: "failing", reason: first.reason, since: new Date(since).toISOString(), sinceAtLeast: atLeast });
    }
    servers.sort((a, b) => a.name.localeCompare(b.name));
    return { servers, note: null };
  }
}

/** One read, without a cache. */
export function readMcpHealth(opts: { roots?: string[]; now?: number } = {}): Promise<HealthReport> {
  return new McpHealth({ roots: opts.roots }).read(opts.now);
}
