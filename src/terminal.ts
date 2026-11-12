/**
 * Opens a comb agent in a terminal: a new tab in the agent's directory that
 * runs `claude attach <name>` (design §9.1). Rex first, Terminal.app if Rex is
 * not there.
 *
 * The caller passes a validated agent name and its session; this module
 * builds every argv itself. Nothing from a request reaches a shell string:
 * Rex gets the command as separate words, and the Terminal fallback passes
 * the directory and name to AppleScript as arguments, which quotes them.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";

import type { AgentSession } from "./agents";
import type { Run } from "./claude";

/** The Rex session that holds the agent tabs the page opens. */
export const REX_SESSION_LABEL = "comb";

/** Where Rex keeps its CLI inside the app bundle (it is not always on PATH). */
const REX_BUNDLE_CLI = "Contents/Helpers/Rex Server.rex/Contents/MacOS/rex";
const REX_APPS = ["/Applications/Rex Beta.app", "/Applications/Rex.app"];

export type Opened = {
  via: "rex" | "terminal";
  dir: string;
  /** What the tab runs, for the page to show and copy. */
  command: string;
};

/** The command the tab runs. */
export function attachArgv(name: string): string[] {
  return ["claude", "attach", name];
}

/**
 * The directory an agent works in. session.json's cwd is already the
 * worktree for a worktree agent, but it has been seen doubled
 * (<wt>/.claude/worktrees/<name> appended to a worktree path), and older
 * records may hold the repo root. So for a worktree agent whose cwd names
 * `.claude/worktrees/<name>`, the path up to its first mention, else cwd with
 * the worktree appended; then cwd itself. The first that exists wins; null
 * when none does.
 */
export function agentWorkdir(s: Pick<AgentSession, "name" | "cwd" | "worktree">, exists: (p: string) => boolean = existsSync): string | null {
  if (!s.worktree) return exists(s.cwd) ? s.cwd : null;
  const seg = `${sep}.claude${sep}worktrees${sep}${s.name}`;
  const at = s.cwd.indexOf(seg);
  const named = at >= 0 && (s.cwd.length === at + seg.length || s.cwd[at + seg.length] === sep);
  const candidates = named
    ? [s.cwd.slice(0, at + seg.length), s.cwd]
    : [join(s.cwd, ".claude", "worktrees", s.name), s.cwd];
  return candidates.find((p) => exists(p)) ?? null;
}

/** The rex CLI: COMB_REX_BIN, then PATH, then inside the app bundle. */
export function findRexBin(exists: (p: string) => boolean = existsSync): string | null {
  if (process.env.COMB_REX_BIN) return process.env.COMB_REX_BIN;
  try {
    const onPath = execSync("command -v rex", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (onPath) return onPath;
  } catch {
    // intentional: not on PATH; look in the app bundle
  }
  for (const app of REX_APPS) {
    const bin = join(app, REX_BUNDLE_CLI);
    if (exists(bin)) return bin;
  }
  return null;
}

export type OpenOpts = {
  name: string;
  dir: string;
  run: Run;
  /** The rex CLI, or null when Rex is not installed. */
  rex: string | null;
  env: Record<string, string>;
};

/**
 * Opens the tab. Tries Rex; on any Rex failure falls back to Terminal.app.
 * Throws only when both fail, with both reasons.
 */
export async function openInTerminal(o: OpenOpts): Promise<Opened> {
  const command = attachArgv(o.name).join(" ");
  let rexProblem = "Rex is not installed";
  if (o.rex) {
    try {
      await openInRex(o.rex, o);
      return { via: "rex", dir: o.dir, command };
    } catch (err) {
      rexProblem = err instanceof Error ? err.message : String(err);
    }
  }
  try {
    await openInTerminalApp(o);
    return { via: "terminal", dir: o.dir, command };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not open a terminal. Rex: ${rexProblem}. Terminal: ${msg}.`);
  }
}

async function rexJson(o: OpenOpts, rex: string, args: string[]): Promise<any> {
  // --autostart=false: if the Rex server is not running, fail and fall back
  // rather than start a headless server Greg cannot see.
  const res = await o.run([rex, "--autostart=false", ...args], { cwd: o.dir, env: o.env });
  if (res.code !== 0) throw new Error(`rex ${args[0]} failed (exit ${res.code}): ${(res.stderr || res.stdout).trim()}`);
  const out = res.stdout.trim();
  return out ? JSON.parse(out) : null;
}

/**
 * One tab per click, in a Rex session labelled "comb" (made on first use),
 * then shown in the Rex app.
 */
async function openInRex(rex: string, o: OpenOpts): Promise<void> {
  const cmd = ["--keep-open", "--json", "--", ...attachArgv(o.name)];
  const ls = await rexJson(o, rex, ["ls", "--json"]);
  const existing = (ls?.sessions ?? []).find((s: { label?: string }) => s.label === REX_SESSION_LABEL);
  let sessionId: string;
  let windowId: string | undefined;
  if (existing) {
    sessionId = existing.session_id;
    const made = await rexJson(o, rex, ["window", "new", "-s", sessionId, o.name, "-c", o.dir, ...cmd]);
    windowId = made?.window_id;
  } else {
    const made = await rexJson(o, rex, ["new", REX_SESSION_LABEL, "-c", o.dir, "--window", o.name, ...cmd]);
    sessionId = made?.session_id;
    windowId = made?.initial_windows?.[0]?.window_id;
  }
  if (!sessionId) throw new Error("rex did not return a session");

  // Show it. Best effort: the tab exists either way.
  try {
    const clients = await rexJson(o, rex, ["client", "ls", "--json"]);
    const app = (clients?.clients ?? []).find((c: { info?: { kind?: string } }) => c.info?.kind === "app");
    if (app) {
      const args = ["-C", app.client_id, "do", "session.select", `session_id=${sessionId}`];
      if (windowId) args.push(`window_id=${windowId}`);
      await o.run([rex, "--autostart=false", ...args], { cwd: o.dir, env: o.env });
      await o.run(["open", "-a", rexAppFor(rex)], { cwd: o.dir, env: o.env });
    }
  } catch {
    // intentional: the tab is open; failing to bring it forward is not an error
  }
}

/** The .app a bundled rex CLI lives in, else Rex Beta. */
function rexAppFor(rex: string): string {
  const i = rex.indexOf(".app/");
  return i >= 0 ? rex.slice(0, i + 4) : REX_APPS[0]!;
}

/**
 * AppleScript gets the directory and name as argv and quotes them with
 * `quoted form of`, so neither is ever parsed as shell or AppleScript.
 */
export const TERMINAL_SCRIPT = [
  "on run argv",
  'set cmd to "cd " & quoted form of (item 1 of argv) & " && claude attach " & quoted form of (item 2 of argv)',
  'tell application "Terminal"',
  "activate",
  "do script cmd",
  "end tell",
  "end run",
];

export function terminalArgv(dir: string, name: string): string[] {
  return ["osascript", ...TERMINAL_SCRIPT.flatMap((l) => ["-e", l]), dir, name];
}

async function openInTerminalApp(o: OpenOpts): Promise<void> {
  const res = await o.run(terminalArgv(o.dir, o.name), { cwd: o.dir, env: o.env });
  if (res.code !== 0) throw new Error(`osascript failed (exit ${res.code}): ${(res.stderr || res.stdout).trim()}`);
}
