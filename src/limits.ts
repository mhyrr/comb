/**
 * Plan limits for the usage panel: the session (5-hour) and weekly bars that
 * Claude Code's `/usage` screen shows.
 *
 * Source: comb's own status-line tee (src/statusline.ts, D28). Claude Code
 * hands `rate_limits` to the statusLine command on every assistant message
 * (`five_hour` and `seven_day`, each with `used_percentage` 0–100 and
 * `resets_at` in Unix seconds); `comb statusline` saves them to
 * ~/.comb/cache/rate-limits.json with the time it saw them. This module reads
 * that file and whether the tee is still installed, and nothing else.
 *
 * The per-model weekly bar (Fable) is not in `rate_limits`; /usage alone shows it.
 */
import { readFile } from "node:fs/promises";

import { claudeSettingsPath, rateLimitsPath, statusLineStatus, type StatusLineStatus } from "./statusline";

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
  | { status: "ok"; asOf: string; stale: boolean; windows: LimitWindow[]; warning: string | null }
  | { status: "missing" | "unreadable"; message: string };

const LABELS: Record<LimitWindow["id"], string> = { five_hour: "Current session", seven_day: "Current week (all models)" };
const INSTALL = "comb init --install-statusline";

const notInstalled = (s: StatusLineStatus) =>
  `comb's status line is not installed${s.command ? ` (settings.json runs "${s.command}")` : ""}, so these bars stop updating. Install: ${INSTALL}`;

/** Reads comb's rate-limits cache. Never throws: a missing or broken file is a status the panel shows. */
export async function readLimits(opts: { home: string; settingsPath?: string; now?: number }): Promise<Limits> {
  const now = opts.now ?? Date.now();
  const install = await statusLineStatus(opts.settingsPath ?? claudeSettingsPath(), opts.home);
  let text: string;
  try {
    text = await readFile(rateLimitsPath(opts.home), "utf-8");
  } catch {
    return {
      status: "missing",
      message: install.installed
        ? "Waiting for the first reading: it comes with the next Claude reply."
        : `Plan limits come from comb's status line, which is not installed. Install: ${INSTALL}`,
    };
  }
  let o: { at?: unknown; rate_limits?: Record<string, { used_percentage?: unknown; resets_at?: unknown } | undefined> };
  try { o = JSON.parse(text); } catch {
    return { status: "unreadable", message: "comb's rate-limits file is not JSON. The next Claude reply rewrites it." };
  }
  const at = typeof o.at === "string" ? Date.parse(o.at) : NaN;
  const windows: LimitWindow[] = [];
  for (const id of ["five_hour", "seven_day"] as const) {
    const w = o.rate_limits?.[id];
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
  if (!windows.length || !Number.isFinite(at)) {
    return { status: "unreadable", message: "comb's rate-limits file has no session or weekly window." };
  }
  return {
    status: "ok",
    asOf: new Date(at).toISOString(),
    stale: now - at > STALE_MS,
    windows,
    warning: install.installed ? null : notInstalled(install),
  };
}
