/**
 * Plan limits for the usage panel: the session (5-hour) and weekly bars that
 * Claude Code's `/usage` screen shows.
 *
 * Source: Claude Code hands `rate_limits` to the statusLine command on every
 * assistant message (code.claude.com/docs/en/statusline: `five_hour` and
 * `seven_day`, each with `used_percentage` 0–100 and `resets_at` in Unix
 * seconds). comb does not own the status line. Greg's is Vibe Island's, which
 * writes that object as-is to ~/.vibe-island/cache/rl.json, and comb reads
 * that file and nothing else: no credentials, no network. The file changes
 * only when an interactive session renders its status line, so every reading
 * carries the file's mtime ("as of").
 *
 * The per-model weekly bar (Fable) is not in `rate_limits`; /usage alone shows it.
 *
 * This module is the only place that knows the source. Swapping it later
 * changes this file and nothing else.
 */
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const defaultLimitsPath = (home = homedir()) => join(home, ".vibe-island", "cache", "rl.json");

/** A reading older than this is marked stale on the panel. */
export const STALE_MS = 30 * 60_000;

export type LimitWindow = {
  id: "five_hour" | "seven_day";
  label: string;
  /** Null once the window has reset since the reading, because the old figure no longer holds. */
  usedPercent: number | null;
  /** When the window resets (or reset), ISO. */
  resetsAt: string | null;
  /** The reset time has passed since the reading. */
  reset: boolean;
};

export type Limits =
  | { status: "ok"; source: string; asOf: string; stale: boolean; windows: LimitWindow[] }
  | { status: "missing" | "unreadable"; source: string; message: string };

const LABELS: Record<LimitWindow["id"], string> = { five_hour: "Current session", seven_day: "Current week (all models)" };

/** Reads the limits file. Never throws: a missing or broken file is a status the panel shows. */
export async function readLimits(path = defaultLimitsPath(), now = Date.now()): Promise<Limits> {
  let text: string;
  let mtime: number;
  try {
    mtime = (await stat(path)).mtimeMs;
    text = await readFile(path, "utf-8");
  } catch {
    return { status: "missing", source: path, message: "Session limits come from Vibe Island's status line; not found." };
  }
  let o: any;
  try { o = JSON.parse(text); } catch {
    return { status: "unreadable", source: path, message: "Vibe Island's limits file is not JSON; it may be mid-write. Trying again shortly." };
  }
  const windows: LimitWindow[] = [];
  for (const id of ["five_hour", "seven_day"] as const) {
    const w = o?.[id];
    if (!w || typeof w.used_percentage !== "number") continue;
    const resetMs = typeof w.resets_at === "number" ? w.resets_at * 1000 : NaN;
    const reset = Number.isFinite(resetMs) && resetMs <= now;
    windows.push({
      id,
      label: LABELS[id],
      usedPercent: reset ? null : Math.max(0, Math.min(100, w.used_percentage)),
      resetsAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
      reset,
    });
  }
  if (!windows.length) {
    return { status: "unreadable", source: path, message: "Vibe Island's limits file has no session or weekly window." };
  }
  return { status: "ok", source: path, asOf: new Date(mtime).toISOString(), stale: now - mtime > STALE_MS, windows };
}
