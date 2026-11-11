/**
 * comb agent workspaces (~/.comb/agents/<name>/) and the start path.
 *
 * The workspace is what lasts: a session can be cleared or die, and a new
 * one starts from charter.md, checklist.md, memory/ and log.md. session.json
 * records the current harness session so the dashboard and parents can find it.
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { UsageError } from "./errors";
import { hiveIdentity, projectForDir } from "./hive";
import { ensureCombScaffold, resolveCombHome } from "./paths";
import {
  findClaudeBin,
  isEnded,
  listLiveSessions,
  runProcess,
  startBackground,
  type LiveSession,
  type Run,
} from "./claude";

/** Greg is the parent of agents he starts himself. He has no session. */
export const GREG = "greg";

export type AgentSession = {
  name: string;
  harness: "claude";
  id: string;
  sessionId: string;
  parent: string;
  project: string | null;
  cwd: string;
  worktree: boolean;
  permissionMode: string;
  startedAt: string;
};

const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;

export function validateAgentName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new UsageError(
      `Agent name "${name}" is not valid. Use lowercase letters, digits and dashes, starting with a letter (max 40).`,
    );
  }
  if (name === GREG) throw new UsageError(`"${GREG}" is reserved for Greg.`);
  return name;
}

export function agentDir(name: string, home: string = resolveCombHome()): string {
  return join(home, "agents", name);
}

const DEFAULT_CHECKLIST = `# Checklist

Each time you wake:

1. Read what arrived (a message, a child's report) and decide what it needs.
2. Check on your children with \`agent_list\`. A child that is gone without a
   report died; decide whether to restart it, replace it, or tell your parent.
3. Append to log.md what you did and why.
`;

export async function createWorkspace(dir: string, name: string, charter: string): Promise<void> {
  await mkdir(join(dir, "reports"), { recursive: true });
  await mkdir(join(dir, "memory"), { recursive: true });
  await writeFile(join(dir, "charter.md"), charter.trim() + "\n", "utf-8");
  await writeFile(join(dir, "checklist.md"), DEFAULT_CHECKLIST, "utf-8");
  await writeFile(join(dir, "log.md"), `# Log: ${name}\n\n`, "utf-8");
}

/** The operating contract appended after HIVE identity. */
export function agentPreamble(a: { name: string; dir: string; parent: string }): string {
  const parentLine = a.parent === GREG
    ? `Your parent is Greg. He reads your reports/ and log.md and may message you directly. Put anything that needs him in a report.`
    : `Your parent is the agent "${a.parent}". Reach it with SendMessage to "${a.parent}" (ListAgents shows names). Tell it when you finish, are stuck, have a question, or have an idea.`;
  return `# comb agent: ${a.name}

You are the comb agent "${a.name}", a long-lived background session. Your
workspace is ${a.dir}. Write only inside it and inside the repo you work in.

- charter.md: what you are for. Read it first. It is your scope; judge what fits.
- checklist.md: what to look at each time you wake.
- log.md: append one line per thing you do, as \`- <ISO time> what, and why\`.
- memory/: your own notes. Keep what matters there, not in your context. Your
  session can be cleared, or restarted from this folder.
- reports/: when you finish a piece of work, write one file named
  YYYY-MM-DD-<slug>.md: what you did, the result, what is left. A session that
  ends without a report is treated as dead.

${parentLine}

When unsure, decide, get a second opinion, or go up to your parent with your
recommendation. To start a child agent for a piece of work, use the comb
\`agent_start\` tool; reach children with SendMessage by name. \`agent_list\`
shows every comb agent and whether its session is alive. Project memory and
tickets are shared through the hive MCP tools.

Code changes happen on your own branch or worktree. Never merge, never push.
External actions follow TRUST.md: ask through your parent.
`;
}

export function resolveCombMcpCommand(): { command: string; args: string[] } {
  if (process.env.COMB_MCP_BIN) return { command: process.env.COMB_MCP_BIN, args: [] };
  try {
    const bin = execSync("which comb-mcp", { encoding: "utf-8" }).trim();
    if (bin) return { command: bin, args: [] };
  } catch { /* intentional: not on PATH — try running from source */ }
  const source = join(import.meta.dir, "mcp-server.ts");
  if (existsSync(source)) return { command: "bun", args: [source] };
  throw new Error("Could not find comb-mcp. Build it: bun run build");
}

async function writeMcpConfig(dir: string, name: string, home: string): Promise<string> {
  const { command, args } = resolveCombMcpCommand();
  const path = join(dir, "mcp.json");
  const config = {
    mcpServers: {
      comb: { type: "stdio", command, args, env: { COMB_AGENT: name, COMB_HOME: home } },
    },
  };
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return path;
}

export async function readAgentSession(name: string, home: string = resolveCombHome()): Promise<AgentSession | null> {
  const path = join(agentDir(name, home), "session.json");
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf-8")) as AgentSession;
}

export type StartAgentOpts = {
  name: string;
  /** Required for a new agent. Omit to restart an existing one from its workspace. */
  charter?: string;
  parent?: string;
  cwd?: string;
  worktree?: boolean;
  prompt?: string;
  home?: string;
  permissionMode?: string;
  claudeBin?: string;
  run?: Run;
  wait?: (ms: number) => Promise<void>;
};

export type StartAgentResult = { session: AgentSession; restarted: boolean; dir: string };

export async function startAgent(opts: StartAgentOpts): Promise<StartAgentResult> {
  const name = validateAgentName(opts.name);
  const home = opts.home ?? resolveCombHome();
  await ensureCombScaffold(home);
  const dir = agentDir(name, home);
  const exists = existsSync(join(dir, "charter.md"));
  const parent = opts.parent ?? GREG;
  const run = opts.run ?? runProcess;
  const claude = opts.claudeBin ?? findClaudeBin();

  if (!exists && !opts.charter?.trim()) {
    throw new UsageError(`Agent "${name}" does not exist yet. Give it a charter.`);
  }
  if (exists && opts.charter?.trim()) {
    throw new UsageError(
      `Agent "${name}" already exists. Edit ${join(dir, "charter.md")} to change its charter, or start it again without one.`,
    );
  }

  const previous = exists ? await readAgentSession(name, home) : null;
  // An ended session stays listed (as "done", or as a stale "blocked" after
  // the daemon retires it); only a live one with this name is a clash.
  const live = await listLiveSessions(claude, run);
  const clash = live.find((s) => s.name === name && !isEnded(s));
  if (clash) {
    throw new UsageError(
      `A session named "${name}" is already running (${clash.id}, ${clash.cwd}). Message it with SendMessage instead.`,
    );
  }

  const cwd = resolve(expandHome(opts.cwd ?? previous?.cwd ?? process.cwd()));
  if (!existsSync(cwd)) throw new UsageError(`Working directory does not exist: ${cwd}`);

  // Identity first: if hive cannot supply it, nothing has been written yet.
  const identity = await hiveIdentity(cwd, run);
  const project = projectForDir(cwd);
  if (!exists) await createWorkspace(dir, name, opts.charter!);

  const systemPromptFile = join(dir, "system-prompt.md");
  await writeFile(systemPromptFile, `${identity}\n\n---\n\n${agentPreamble({ name, dir, parent })}`, "utf-8");
  const mcpConfigFile = await writeMcpConfig(dir, name, home);

  // A workspace made by `comb init` has a charter but has never run.
  const ranBefore = previous !== null;
  const prompt = opts.prompt?.trim() || (ranBefore
    ? "You were restarted from your workspace. Read charter.md, checklist.md, memory/ and the end of log.md, then carry on."
    : "Read your charter.md and checklist.md, then begin.");
  const permissionMode = opts.permissionMode ?? process.env.COMB_PERMISSION_MODE ?? "auto";

  // A previous session that died keeps its history; wake it rather than lose it.
  const resume = previous && previous.cwd === cwd ? previous.sessionId : undefined;
  let started;
  try {
    started = await startBackground(
      claude,
      { name, cwd, systemPromptFile, mcpConfigFile, prompt, permissionMode, resume, worktree: !resume && opts.worktree },
      run,
      opts.wait,
    );
  } catch (err) {
    // A new agent that never started leaves nothing behind, so the same
    // start can simply be retried.
    if (!exists) await rm(dir, { recursive: true, force: true });
    throw err;
  }

  const session: AgentSession = {
    name,
    harness: "claude",
    id: started.id,
    sessionId: started.sessionId,
    parent,
    project,
    cwd: started.cwd,
    worktree: previous?.worktree ?? !!opts.worktree,
    permissionMode,
    startedAt: new Date().toISOString(),
  };
  await writeFile(join(dir, "session.json"), JSON.stringify(session, null, 2) + "\n", "utf-8");
  const verb = ranBefore ? (resume ? "resumed" : "restarted") : "started";
  await appendFile(
    join(dir, "log.md"),
    `- ${session.startedAt} ${verb} by ${parent} in ${session.cwd} (session ${session.id})\n`,
    "utf-8",
  );
  return { session, restarted: ranBefore, dir };
}

function expandHome(path: string): string {
  const home = process.env.HOME || homedir();
  return path === "~" || path.startsWith("~/") ? home + path.slice(1) : path;
}

export type AgentStatus = {
  name: string;
  parent: string | null;
  /** working / idle / blocked from the harness, or "gone" when the session is not live. */
  state: string;
  cwd: string | null;
  reports: number;
  lastLog: string | null;
};

export async function listAgents(opts: { home?: string; claudeBin?: string; run?: Run } = {}): Promise<AgentStatus[]> {
  const home = opts.home ?? resolveCombHome();
  const root = join(home, "agents");
  if (!existsSync(root)) return [];
  const names = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  if (names.length === 0) return [];

  const live = await listLiveSessions(opts.claudeBin ?? findClaudeBin(), opts.run ?? runProcess);
  const bySession = new Map<string, LiveSession>(live.map((s) => [s.sessionId, s]));

  const out: AgentStatus[] = [];
  for (const name of names) {
    const dir = join(root, name);
    const session = await readAgentSession(name, home);
    const row = session ? bySession.get(session.sessionId) : undefined;
    const reportsDir = join(dir, "reports");
    const reports = existsSync(reportsDir) ? readdirSync(reportsDir).filter((f) => f.endsWith(".md")).length : 0;
    out.push({
      name,
      parent: session?.parent ?? null,
      state: row ? displayState(row) : "gone",
      cwd: session?.cwd ?? null,
      reports,
      lastLog: await lastLogLine(join(dir, "log.md")),
    });
  }
  return out;
}

/**
 * Claude reports a waiting session as state "blocked", status "idle". Show
 * "idle" for that; keep the end states ("done", "failed") as they are.
 */
function displayState(row: LiveSession): string {
  if (row.state === "failed") return "failed";
  if (isEnded(row)) return "done";
  return row.status ?? row.state ?? "live";
}

async function lastLogLine(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const lines = (await readFile(path, "utf-8")).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return lines.at(-1) ?? null;
}

export function formatAgentList(rows: AgentStatus[]): string {
  if (rows.length === 0) return "No comb agents yet.";
  return rows
    .map((r) => {
      const head = `${r.name}  [${r.state}]  parent: ${r.parent ?? "?"}  reports: ${r.reports}`;
      return r.lastLog ? `${head}\n    ${r.lastLog}` : head;
    })
    .join("\n");
}
