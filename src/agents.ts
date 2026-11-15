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

import IDENTITY_TEMPLATE from "../templates/identity.md" with { type: "text" };
import { human, readCombConfig, renderTemplate, type CombConfig, type Human } from "./config";
import { UsageError } from "./errors";
import { detectHive, hiveIdentity, projectForDir, type HiveSetup } from "./hive";
import { pageSignature } from "./transcript";
import { ensureCombScaffold, resolveCombHome } from "./paths";
import {
  findClaudeBin,
  isEnded,
  stopSession,
  listLiveSessions,
  relayMessage,
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
  /** The model it was started with, from its settings.json. Null only in records from before D25. */
  model?: string | null;
  startedAt: string;
};

/** Per-agent settings Greg can edit: `<workspace>/settings.json`. */
export type AgentSettings = { model?: string };

export async function readAgentSettings(dir: string): Promise<AgentSettings> {
  const path = join(dir, "settings.json");
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as AgentSettings;
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch (err) {
    throw new UsageError(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function writeAgentSettings(dir: string, settings: AgentSettings): Promise<void> {
  await writeFile(join(dir, "settings.json"), JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

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

1. Read what arrived (a message, a child's report) and act on it.
2. Find the next thing you can move forward without waiting, and move it.
3. Append to log.md what you did, what you decided, and why.
`;

export async function createWorkspace(dir: string, name: string, charter: string): Promise<void> {
  await mkdir(join(dir, "reports"), { recursive: true });
  await mkdir(join(dir, "memory"), { recursive: true });
  await writeFile(join(dir, "charter.md"), charter.trim() + "\n", "utf-8");
  await writeFile(join(dir, "checklist.md"), DEFAULT_CHECKLIST, "utf-8");
  await writeFile(join(dir, "log.md"), `# Log: ${name}\n\n`, "utf-8");
}

/**
 * The operating contract appended after the identity. `user` is how it names
 * the human (config.json's userName, else "the user"). `hive` keeps the lines
 * about hive's tools and TRUST.md; without hive they are left out (D24).
 */
export function agentPreamble(a: { name: string; dir: string; parent: string; user?: Human; hive?: boolean }): string {
  const { name: u, Name: U } = a.user ?? { name: "the user", Name: "The user" };
  const hive = a.hive ?? true;
  const parentLine = a.parent === GREG
    ? `Your parent is ${u}. ${U} reads your reports and log, and may message you directly.`
    : `Your parent is the agent "${a.parent}". Tell it with \`agent_send\` when you finish, are stuck, or have a question or an idea.`;
  const who = a.name === "maya"
    ? `You are Maya, as the identity above says, running as the comb agent "maya".`
    : `The identity above is the ${hive ? "hive's" : "team's"} shared voice and standards. Its name and role are Maya's. Here you are the comb agent "${a.name}", and your role is your charter. Maya is the comb agent "maya", the chief of staff.`;
  const external = hive ? "TRUST.md" : "push, deploy, send, post, spend";
  const memory = hive
    ? "Project knowledge that should outlast you goes to hive with\n  `write_hive_memory`."
    : "Project knowledge that should outlast you goes in the repo's docs\n  or your report.";
  return `# comb agent: ${a.name}

${who}

You are a background session with one job: your charter. Your workspace is
${a.dir}. Write files only there and in the repo you work in.

When the job is done, write the report, tell your parent, and stop. You are
not done for good: follow-ups and corrections come back to you as messages,
because your context is this job. ${U} can read and message you on the comb
page while you work.

## Push the work forward

Take the work as far as you can on your own. ${U} wants decisions made, not
questions asked.

- Decide and act when the step is reversible and inside your charter. Then
  tell your parent what you decided and why, in your next message or report.
- Bring it up first, with your recommendation, when the step is external
  (${external}), cannot be undone, or sets direction ${u} has not set: a
  design call, a change of scope, a trade-off ${u} would want to weigh.
- To bring something to ${u}, file it with \`queue_add\`: one item per ask,
  with what you will do on "go" and your case for it. ${U} answers on the
  page with Go, Not now or Redirect, and the answer comes back to you as a
  message. Do not bury asks in a report or a long reply; ${u} acts on the
  queue.
- When you wait on an answer, keep working on what does not depend on it.
- For a second opinion, use a sub-agent.${hive ? ` Council needs ${u}'s yes.` : ""}

## Your workspace

- charter.md: what you are for. Read it first. Judge what fits it.
- checklist.md: what to look at each time you wake.
- log.md: one line per thing you do, as \`- <ISO time> what, and why\`.
  Decisions go here too.
- memory/: your working notes, so a fresh session can pick up from this
  folder. ${memory}
- reports/: one file per finished piece of work, YYYY-MM-DD-<slug>.md: what
  you did, the decisions you made, what you verified and how, and what is
  left. Answers to questions go back as messages, not reports.

## Other agents

${parentLine}

\`agent_list\` is the roster. \`agent_send\` reaches any agent or session by
name, working or asleep. When a message names its sender, reply with
\`agent_send\` to that name.${hive ? " Tickets and memory are shared through the hive\nMCP tools." : ""}

Split work the way it runs best. Use your harness's sub-agents for parallel
reading and checks inside your job. Use \`agent_start\` for a separate job
that should run on its own and report back: you become its parent, give it a
charter that says what done means and where its context is, and set worktree
when it edits code.

${U}'s own sessions (interactive, in \`claude agents\`) are outside the tree.
Answer one that writes to you; never hand one work.

## Limits

Code changes go on your own branch or worktree. Never merge or push. Other
external actions ${hive ? "follow TRUST.md" : "(push, deploy, send, post, spend) are not yours"}: ask through your parent.
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
  /**
   * Model for this agent. Omitted: the one in its settings.json, else
   * config.json's defaultModel. Saved to settings.json, so restarts keep it.
   */
  model?: string;
  claudeBin?: string;
  run?: Run;
  wait?: (ms: number) => Promise<void>;
  /** Whether to use hive. Detected when omitted. */
  hive?: HiveSetup;
};

/**
 * The identity agents get without hive: config.json's identityFile, else
 * `<COMB_HOME>/identity.md` (comb init writes it), else the default shipped
 * in templates/identity.md. A named identityFile that is missing fails the
 * start, so a typo is not silently replaced by the default.
 */
export async function localIdentity(home: string, config: CombConfig, hive = false): Promise<string> {
  let text = IDENTITY_TEMPLATE;
  if (config.identityFile) {
    if (!existsSync(config.identityFile)) {
      throw new UsageError(`identityFile in ${join(home, "config.json")} is ${config.identityFile}, which does not exist.`);
    }
    text = await readFile(config.identityFile, "utf-8");
  } else if (existsSync(join(home, "identity.md"))) {
    text = await readFile(join(home, "identity.md"), "utf-8");
  }
  // Rendered at every start, so {{user}} in any of them follows config.json.
  return renderTemplate(text, { human: human(config), hive });
}

/** comb's default identity, as shipped (with {{user}} placeholders). */
export { IDENTITY_TEMPLATE };

export type StartAgentResult = { session: AgentSession; restarted: boolean; dir: string };

export async function startAgent(opts: StartAgentOpts): Promise<StartAgentResult> {
  const name = validateAgentName(opts.name);
  const home = opts.home ?? resolveCombHome();
  await ensureCombScaffold(home);
  const dir = agentDir(name, home);
  const exists = existsSync(join(dir, "charter.md"));
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
  const parent = opts.parent ?? previous?.parent ?? GREG;
  // An ended session stays listed (as "done", or as a stale "blocked" after
  // the daemon retires it); only a live one with this name is a clash.
  const live = await listLiveSessions(claude, run);
  const clash = live.find((s) => s.name === name && !isEnded(s));
  if (clash) {
    throw new UsageError(
      `A session named "${name}" is already running (${clash.id}, ${clash.cwd}). Message it with SendMessage instead.`,
    );
  }
  // A finished session can keep its process (state done, with a pid). Stop it,
  // so the new one is the only session with this name.
  for (const stale of live.filter((s) => s.name === name && s.pid && isEnded(s))) {
    await stopSession(claude, stale.id, run);
  }

  const cwd = resolve(expandHome(opts.cwd ?? previous?.cwd ?? process.cwd()));
  if (!existsSync(cwd)) throw new UsageError(`Working directory does not exist: ${cwd}`);

  // Identity first: if it cannot be had, nothing has been written yet. With
  // hive, it is hive's, as always; without, comb's own file (D24).
  const config = readCombConfig(home);
  const hive = opts.hive ?? detectHive({ mode: config.hive });
  const identity = hive.enabled ? await hiveIdentity(cwd, run, hive.bin) : await localIdentity(home, config, hive.enabled);
  const project = hive.enabled ? projectForDir(cwd, hive.home) : null;
  if (!exists) await createWorkspace(dir, name, opts.charter!);

  const systemPromptFile = join(dir, "system-prompt.md");
  const preamble = agentPreamble({ name, dir, parent, user: human(config), hive: hive.enabled });
  await writeFile(systemPromptFile, `${identity}\n\n---\n\n${preamble}`, "utf-8");
  const mcpConfigFile = await writeMcpConfig(dir, name, home);

  // A workspace made by `comb init` has a charter but has never run.
  const ranBefore = previous !== null;
  const prompt = opts.prompt?.trim() || (ranBefore
    ? "You were restarted from your workspace. Read charter.md, checklist.md, memory/ and the end of log.md, then carry on."
    : "Read your charter.md and checklist.md, then begin.");
  const permissionMode = opts.permissionMode ?? process.env.COMB_PERMISSION_MODE ?? "auto";
  // The named model, else the one this agent already runs on, else
  // config.json's defaultModel (D25). Saved, so a wake keeps it.
  const settings = await readAgentSettings(dir);
  const model = opts.model?.trim() || settings.model?.trim() || config.defaultModel;
  if (model !== settings.model) {
    settings.model = model;
    await writeAgentSettings(dir, settings);
  }

  // A previous session that died keeps its history; wake it rather than lose it.
  const resume = previous && previous.cwd === cwd ? previous.sessionId : undefined;
  let started;
  try {
    started = await startBackground(
      claude,
      { name, cwd, systemPromptFile, mcpConfigFile, prompt, permissionMode, model, resume, worktree: !resume && opts.worktree },
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
    // A new worktree session moves into <repo>/.claude/worktrees/<name> after
    // it is listed; record that, so a wake resumes it there.
    cwd: !resume && opts.worktree ? join(started.cwd, ".claude", "worktrees", name) : started.cwd,
    worktree: previous?.worktree ?? !!opts.worktree,
    permissionMode,
    model,
    startedAt: new Date().toISOString(),
  };
  await writeFile(join(dir, "session.json"), JSON.stringify(session, null, 2) + "\n", "utf-8");
  const verb = ranBefore ? (resume ? "resumed" : "restarted") : "started";
  await appendFile(
    join(dir, "log.md"),
    `- ${session.startedAt} ${verb} by ${parent} in ${session.cwd} (session ${session.id}, model ${model})\n`,
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
  /** "working" while it is on a turn; otherwise "ready". A message reaches it either way. */
  state: "working" | "ready";
  /** The first line of its charter. */
  about: string | null;
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
    out.push({
      name,
      parent: session?.parent ?? null,
      state: row && isWorking(row) ? "working" : "ready",
      about: await firstLine(join(dir, "charter.md")),
      lastLog: await lastLogLine(join(dir, "log.md")),
    });
  }
  return out;
}

function isWorking(row: LiveSession): boolean {
  if (isEnded(row)) return false;
  return row.status === "busy" || row.status === "working" || row.state === "working";
}

async function firstLine(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const line = (await readFile(path, "utf-8")).split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean);
  if (!line) return null;
  return line.length > 100 ? line.slice(0, 99) + "…" : line;
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
      const head = `${r.name}  [${r.state}]${r.about ? `  ${r.about}` : ""}`;
      return r.lastLog ? `${head}\n    last: ${r.lastLog}` : head;
    })
    .join("\n");
}

export type SendOpts = {
  name: string;
  message: string;
  /** Session name to reply to. Omitted, the agent is not asked to reply. */
  from?: string | null;
  /** Greg wrote it on comb's page. He reads the answer there, in the agent's transcript. */
  fromPage?: boolean;
  home?: string;
  claudeBin?: string;
  run?: Run;
  wait?: (ms: number) => Promise<void>;
};

/**
 * Delivers a message to an agent whatever its session is doing. A live
 * session gets it through the relay; an ended one is resumed with the
 * message as its prompt, so it wakes with its history and the message.
 */
export async function sendToAgent(opts: SendOpts): Promise<{ woke: boolean; session: AgentSession | null }> {
  const name = opts.name;
  const home = opts.home ?? resolveCombHome();
  const run = opts.run ?? runProcess;
  const claude = opts.claudeBin ?? findClaudeBin();
  const who = human(readCombConfig(home));
  const text = opts.fromPage
    ? `${pageSignature(who.Name)}\n(${who.Name} reads your answer on the page. Answer in your reply; do not use agent_send for it.)\n\n${opts.message}`
    : opts.from
      ? `Message from ${opts.from}. Reply with the comb agent_send tool to "${opts.from}".\n\n${opts.message}`
      : opts.message;

  if (!NAME_RE.test(name) || !existsSync(join(agentDir(name, home), "charter.md"))) {
    // Not an agent: a live session by that name, such as Greg's, still gets it.
    const session = (await listLiveSessions(claude, run)).find((s) => s.name === opts.name && !isEnded(s));
    if (!session) {
      throw new UsageError(`There is no agent or session named "${opts.name}". agent_list shows the agents; agent_start makes a new one.`);
    }
    // Greg's own sessions are outside the tree (D9). An agent may answer one
    // that wrote to it, but never hands it work.
    if (!opts.fromPage && opts.from && session.kind === "interactive" && isAgent(opts.from, home)
      && !(await heardFrom(opts.from, opts.name, home))) {
      throw new UsageError(
        `"${opts.name}" is one of ${who.name}'s own sessions, outside the tree. To get work done, start a task agent with agent_start; to ask ${who.name}, use queue_add.`,
      );
    }
    await relayMessage(claude, opts.name, text, run);
    return { woke: false, session: null };
  }

  const previous = await readAgentSession(name, home);
  const row = previous
    ? (await listLiveSessions(claude, run)).find((s) => s.sessionId === previous.sessionId)
    : undefined;
  if (previous && row && !isEnded(row)) {
    await relayMessage(claude, name, text, run);
    await appendFile(
      join(agentDir(name, home), "log.md"),
      `- ${new Date().toISOString()} message from ${opts.fromPage ? "greg (page)" : opts.from ?? "unknown"} delivered\n`,
      "utf-8",
    );
    return { woke: false, session: previous };
  }
  const { session } = await startAgent({ name, prompt: text, home, claudeBin: claude, run, wait: opts.wait });
  await appendFile(
    join(agentDir(name, home), "log.md"),
    `- ${new Date().toISOString()} message from ${opts.fromPage ? "greg (page)" : opts.from ?? "unknown"} delivered (woke)\n`,
    "utf-8",
  );
  return { woke: true, session };
}

function isAgent(name: string, home: string): boolean {
  return NAME_RE.test(name) && existsSync(join(agentDir(name, home), "charter.md"));
}

/** Whether `agent`'s log shows a message delivered from `session`. */
async function heardFrom(agent: string, session: string, home: string): Promise<boolean> {
  const log = join(agentDir(agent, home), "log.md");
  if (!existsSync(log)) return false;
  return (await readFile(log, "utf-8")).includes(`message from ${session} delivered`);
}
