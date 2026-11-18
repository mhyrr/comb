/**
 * comb's status-line tee (design D28). Claude Code hands the statusLine
 * command a JSON object on stdin with every assistant message; when the user
 * is on a subscription it holds `rate_limits` (code.claude.com/docs/en/statusline).
 * `comb statusline` saves that one object to ~/.comb/cache/rate-limits.json for
 * the page's limit bars, then runs the status line command that was there
 * before, with the same stdin, and passes its output through unchanged.
 *
 * Installing it is the one change comb makes to global Claude config, and only
 * on the user's yes: `comb init` asks, `--install-statusline` installs,
 * `--undo-statusline` restores the old setting. Only `statusLine.command`
 * changes; the old `statusLine` object is kept in ~/.comb/statusline.json and
 * settings.json is backed up to ~/.comb/backups/ first.
 */
import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { UsageError } from "./errors";

/** Set in the wrapped command's env, so a status line that calls comb again cannot loop. */
export const GUARD_ENV = "COMB_STATUSLINE";

export const claudeSettingsPath = (env = process.env) =>
  join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
export const statePath = (home: string) => join(home, "statusline.json");
export const rateLimitsPath = (home: string) => join(home, "cache", "rate-limits.json");
const logPath = (home: string) => join(home, "logs", "statusline.log");

export type StatusLineSetting = { [key: string]: unknown; type?: string; command?: string };
/** What install remembers: the statusLine object it replaced (null when there was none). */
export type SavedState = { previous: StatusLineSetting | null; installedAt: string; command: string };

/** The cache file: the rate-limit windows and when they were seen. Nothing else from stdin. */
export type RateLimitsCache = { at: string; rate_limits: { five_hour?: unknown; seven_day?: unknown } };

/**
 * Whether a statusLine command is comb's tee: the exact command comb installed
 * (when known), or any `comb…` binary followed by `statusline`.
 */
export function isCombCommand(command: unknown, installed?: string | null): boolean {
  if (typeof command !== "string") return false;
  const c = command.trim();
  return (!!installed && c === installed.trim()) || /(^|[/\s'"])comb[\w.-]*['"]?\s+statusline$/.test(c);
}

/** The command line settings.json gets: this comb binary, quoted if its path needs it. */
export function teeCommand(bin: string): string {
  return `${/[\s'"$`\\]/.test(bin) ? `'${bin.replaceAll("'", `'\\''`)}'` : bin} statusline`;
}

/** The comb binary to put in settings.json. Under `bun src/cli.ts`, the `comb` on PATH. */
export function combBinary(): string {
  return basename(process.execPath) === "bun" ? (Bun.which("comb") ?? "comb") : process.execPath;
}

// ---------------------------------------------------------------- settings.json

async function readSettings(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  const text = await readFile(path, "utf-8");
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through to the error below
  }
  throw new UsageError(`${path} is not a JSON object; comb left it alone.`);
}

/** Writes settings.json whole, through a temp file, keeping its mode. */
async function writeSettings(path: string, settings: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const mode = existsSync(path) ? (await stat(path)).mode & 0o777 : 0o644;
  const tmp = `${path}.comb-${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2) + "\n", { mode });
  await rename(tmp, path);
}

async function backup(home: string, path: string, now: Date): Promise<string | null> {
  if (!existsSync(path)) return null;
  const dir = join(home, "backups");
  await mkdir(dir, { recursive: true });
  const to = join(dir, `settings.json.${now.toISOString().replace(/[:.]/g, "-")}`);
  await copyFile(path, to);
  return to;
}

const asSetting = (v: unknown): StatusLineSetting | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as StatusLineSetting) : null;

export type StatusLineStatus = { installed: boolean; command: string | null };

/** Whether settings.json runs comb's tee now. Read only; the page uses it to warn. */
export async function statusLineStatus(settingsPath = claudeSettingsPath(), home?: string): Promise<StatusLineStatus> {
  try {
    const command = asSetting((await readSettings(settingsPath)).statusLine)?.command;
    const installed = isCombCommand(command, home ? (await readState(home))?.command : null);
    return { installed, command: typeof command === "string" ? command : null };
  } catch {
    return { installed: false, command: null };
  }
}

export async function installStatusLine(opts: {
  home: string;
  settingsPath?: string;
  bin?: string;
  now?: Date;
}): Promise<{ changed: boolean; message: string }> {
  const settingsPath = opts.settingsPath ?? claudeSettingsPath();
  const now = opts.now ?? new Date();
  const settings = await readSettings(settingsPath);
  const current = asSetting(settings.statusLine);
  if (isCombCommand(current?.command, (await readState(opts.home))?.command)) {
    return { changed: false, message: `statusline: already comb's tee (${current!.command})` };
  }
  const command = teeCommand(opts.bin ?? combBinary());
  const saved = await backup(opts.home, settingsPath, now);
  const state: SavedState = { previous: current, installedAt: now.toISOString(), command };
  await writeFile(statePath(opts.home), JSON.stringify(state, null, 2) + "\n");
  // Only the command changes: padding, refreshInterval and any other key stay.
  settings.statusLine = { ...(current ?? {}), type: "command", command };
  await writeSettings(settingsPath, settings);
  return {
    changed: true,
    message: [
      `statusline: installed. ${settingsPath} now runs "${command}",`,
      current?.command ? `which saves rate limits for the page and then runs your old status line ("${current.command}").` : "which saves rate limits for the page (you had no status line, so it prints nothing).",
      saved ? `Backup: ${saved}.` : "",
      "Undo with: comb init --undo-statusline",
    ].filter(Boolean).join(" "),
  };
}

export async function undoStatusLine(opts: { home: string; settingsPath?: string; now?: Date }): Promise<{ changed: boolean; message: string }> {
  const settingsPath = opts.settingsPath ?? claudeSettingsPath();
  const state = await readState(opts.home);
  if (!state) return { changed: false, message: "statusline: comb never installed its tee here; nothing to undo." };
  const settings = await readSettings(settingsPath);
  const current = asSetting(settings.statusLine);
  if (!isCombCommand(current?.command, state.command)) {
    return {
      changed: false,
      message: `statusline: ${settingsPath} now runs ${current?.command ? `"${current.command}"` : "no status line"}, not comb's tee; left as is.`,
    };
  }
  const saved = await backup(opts.home, settingsPath, opts.now ?? new Date());
  if (state.previous) settings.statusLine = state.previous;
  else delete settings.statusLine;
  await writeSettings(settingsPath, settings);
  await rm(statePath(opts.home), { force: true });
  return {
    changed: true,
    message: `statusline: restored ${state.previous?.command ? `"${state.previous.command}"` : "no status line"} in ${settingsPath}.${saved ? ` Backup: ${saved}.` : ""}`,
  };
}

export async function readState(home: string): Promise<SavedState | null> {
  try {
    const s = JSON.parse(await readFile(statePath(home), "utf-8"));
    return s && typeof s === "object" && "previous" in s ? (s as SavedState) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the tee

/** Saves `rate_limits` when stdin carries a session or weekly window. Never throws. */
export async function saveRateLimits(input: Uint8Array, home: string, now = new Date()): Promise<boolean> {
  let o: unknown;
  try { o = JSON.parse(new TextDecoder().decode(input)); } catch { return false; }
  const rl = (o as { rate_limits?: { five_hour?: unknown; seven_day?: unknown } } | null)?.rate_limits;
  if (!rl || (!rl.five_hour && !rl.seven_day)) return false;
  const out: RateLimitsCache = { at: now.toISOString(), rate_limits: { five_hour: rl.five_hour, seven_day: rl.seven_day } };
  try {
    const path = rateLimitsPath(home);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(out) + "\n");
    await rename(tmp, path);
    return true;
  } catch {
    return false; // intentional: a status line never fails because comb's cache could not be written
  }
}

export type TeeResult = { code: number; stdout: Uint8Array; stderr: Uint8Array };
const EMPTY = new Uint8Array();

/**
 * One status-line run. The cache is written first, so a slow or killed status
 * line never loses the reading; then the old command runs under /bin/sh with
 * the same stdin, cwd and env (COLUMNS, LINES), and its output comes back as is.
 */
export async function runTee(input: Uint8Array, opts: { home: string; env?: Record<string, string | undefined> }): Promise<TeeResult> {
  const env = opts.env ?? process.env;
  // Inside our own wrapped command: comb is already teeing, so do nothing.
  if (env[GUARD_ENV] === "1") return { code: 0, stdout: EMPTY, stderr: EMPTY };
  await saveRateLimits(input, opts.home);
  const command = (await readState(opts.home))?.previous?.command;
  if (typeof command !== "string" || !command.trim() || isCombCommand(command)) return { code: 0, stdout: EMPTY, stderr: EMPTY };

  const child = Bun.spawn(["/bin/sh", "-c", command], {
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...env, [GUARD_ENV]: "1" },
  });
  // Claude Code owns the timeout. When it stops us, stop the child too.
  const forward = (sig: NodeJS.Signals) => () => { child.kill(sig); };
  const handlers = (["SIGTERM", "SIGINT", "SIGHUP"] as const).map((sig) => [sig, forward(sig)] as const);
  for (const [sig, fn] of handlers) process.on(sig, fn);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).bytes(),
      new Response(child.stderr).bytes(),
      child.exited,
    ]);
    if (code === 127) {
      // The old status line is gone (uninstalled, moved). Show nothing rather than an error.
      await logOnceAnHour(opts.home, `the previous status line command was not found: ${command}`);
      return { code: 0, stdout: EMPTY, stderr: EMPTY };
    }
    return { code, stdout, stderr };
  } finally {
    for (const [sig, fn] of handlers) process.off(sig, fn);
  }
}

async function logOnceAnHour(home: string, line: string): Promise<void> {
  try {
    const path = logPath(home);
    if (existsSync(path) && Date.now() - (await stat(path)).mtimeMs < 3600_000) return;
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // intentional: logging must never break the status line
  }
}
