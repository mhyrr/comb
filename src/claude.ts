/**
 * Claude Code adapter for comb agents: start a background session, list live
 * ones. Messages are not here: Claude agents use the harness's SendMessage.
 * Flags verified against Claude Code 2.1.322; see docs/design.md.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type RunResult = { code: number; stdout: string; stderr: string };
export type Run = (
  argv: string[],
  opts: { cwd: string; env: Record<string, string>; stdin?: string },
) => Promise<RunResult>;

export const runProcess: Run = async (argv, opts) => {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

export function findClaudeBin(): string {
  if (process.env.COMB_CLAUDE_BIN) return process.env.COMB_CLAUDE_BIN;
  try {
    return execSync("which claude", { encoding: "utf-8" }).trim();
  } catch {
    // intentional: not on PATH — try the installer's default location
    const fallback = join(process.env.HOME || "", ".local", "bin", "claude");
    if (existsSync(fallback)) return fallback;
    throw new Error("Could not find the claude CLI. Is it installed?");
  }
}

/** One row of `claude agents --json`. Only the fields comb reads. */
export type LiveSession = {
  id: string;
  sessionId: string;
  name: string;
  cwd: string;
  kind?: string;
  state?: string;
  status?: string;
  pid?: number;
};

/**
 * Whether a session has ended. Claude's daemon retires a background session
 * after 3h at an idle prompt and logs it as done, but `claude agents` can keep
 * its last state ("blocked") with no status and no pid. A live background row
 * always has a status, so a background row without one has ended.
 */
export function isEnded(row: LiveSession): boolean {
  if (row.state === "done" || row.state === "failed") return true;
  return row.kind === "background" && !row.status;
}

/** Live sessions, or with `all` also finished and failed ones. */
export async function listLiveSessions(
  claude: string,
  run: Run = runProcess,
  all = false,
): Promise<LiveSession[]> {
  const argv = [claude, "agents", "--json", ...(all ? ["--all"] : [])];
  const res = await run(argv, { cwd: process.cwd(), env: childEnv() });
  if (res.code !== 0) {
    throw new Error(`claude agents --json failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
  }
  const parsed = JSON.parse(res.stdout) as unknown;
  if (!Array.isArray(parsed)) throw new Error("claude agents --json did not return a list");
  return parsed as LiveSession[];
}

/**
 * Delivers a message to a live session by name. Claude has no CLI for
 * SendMessage and its transport is internal, so a one-shot `claude -p` that
 * may only use SendMessage does the send (about 5 seconds). The prompt goes on
 * stdin because --allowedTools takes a list and would swallow it.
 */
export async function relayMessage(claude: string, to: string, text: string, run: Run = runProcess): Promise<void> {
  const prompt = [
    `Call the SendMessage tool exactly once, to "${to}", with the text between the markers as the message, unchanged.`,
    "Then reply with the single word SENT if it succeeded, or FAILED and the tool's error if it did not.",
    "<<<MESSAGE",
    text,
    "MESSAGE>>>",
  ].join("\n");
  const argv = [claude, "-p", "--model", "haiku", "--allowedTools", "SendMessage"];
  const res = await run(argv, { cwd: process.cwd(), env: childEnv(), stdin: prompt });
  const out = res.stdout.trim();
  if (res.code !== 0 || !/\bSENT\b/.test(out) || /\bFAILED\b/.test(out)) {
    throw new Error(`Could not deliver to ${to}: ${out || res.stderr.trim() || `exit ${res.code}`}`);
  }
}

/**
 * Stops a background session. A finished turn can leave the process alive
 * as `done` with a pid; a wake must stop it first, or two sessions share the
 * agent's name and SendMessage cannot tell them apart.
 */
export async function stopSession(claude: string, id: string, run: Run = runProcess): Promise<void> {
  const res = await run([claude, "stop", id], { cwd: process.cwd(), env: childEnv() });
  if (res.code !== 0) throw new Error(`Could not stop session ${id}: ${res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`}`);
}

/**
 * Environment for a detached agent. Subscription OAuth only (D12): an API key
 * in the environment would silently switch billing. Identity arrives through
 * the system prompt, so the SessionStart hook must not emit it again.
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && k !== "ANTHROPIC_API_KEY") env[k] = v;
  }
  env.HIVE_IDENTITY_IN_PROMPT = "1";
  return env;
}

export type StartSpec = {
  name: string;
  cwd: string;
  systemPromptFile: string;
  mcpConfigFile: string;
  prompt: string;
  permissionMode: string;
  /** Model alias or ID ("opus", "sonnet", "fable"). Omitted, Claude Code's default. */
  model?: string;
  /** Session ID to resume instead of starting fresh. */
  resume?: string;
  /** Ask Claude to make a git worktree (named after the agent). */
  worktree?: boolean;
};

export function buildStartArgv(claude: string, spec: StartSpec): string[] {
  // --mcp-config takes a list and would swallow the prompt as a second config
  // file, so a single-value flag must always follow it.
  const argv = [
    claude, "--bg",
    "--mcp-config", spec.mcpConfigFile,
    "-n", spec.name,
    "--permission-mode", spec.permissionMode,
    ...(spec.model ? ["--model", spec.model] : []),
    "--append-system-prompt-file", spec.systemPromptFile,
  ];
  if (spec.resume) argv.push("--resume", spec.resume);
  else if (spec.worktree) argv.push("-w", spec.name);
  argv.push(spec.prompt);
  return argv;
}

/** Parses `backgrounded · 17e458d3 · smoke`. */
export function parseBackgrounded(stdout: string): string | null {
  const m = stdout.match(/backgrounded\s*·\s*([0-9a-f]{6,})\s*·/);
  return m ? m[1]! : null;
}

export type Started = { id: string; sessionId: string; cwd: string };

export async function startBackground(
  claude: string,
  spec: StartSpec,
  run: Run = runProcess,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Started> {
  const res = await run(buildStartArgv(claude, spec), { cwd: spec.cwd, env: childEnv() });
  const out = `${res.stdout}\n${res.stderr}`;
  if (/not trusted/i.test(out)) {
    throw new Error(
      `Claude has not trusted ${spec.cwd}. Open claude there once and accept the trust prompt, then start the agent again.`,
    );
  }
  const id = parseBackgrounded(out);
  if (res.code !== 0 || !id) {
    throw new Error(`claude --bg failed (exit ${res.code}): ${out.trim()}`);
  }
  // The session shows up in `claude agents` a moment after --bg returns. A
  // session that dies at once only appears under --all, as "failed".
  for (let attempt = 0; attempt < 20; attempt++) {
    const row = (await listLiveSessions(claude, run, true)).find((s) => s.id === id);
    if (row?.state === "failed") {
      throw new Error(`Session ${id} failed at start. Inspect it with: claude agents --all`);
    }
    if (row) return { id, sessionId: row.sessionId, cwd: row.cwd };
    await wait(500);
  }
  throw new Error(`Session ${id} started but never appeared in claude agents --json.`);
}
