/**
 * comb init: create ~/.comb, Maya's workspace, and link comb's skills for
 * Greg's own sessions. Skills are symlinked into ~/.claude/skills from this
 * repo, so there is one copy and edits are live. Nothing that already exists is overwritten.
 */
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { createWorkspace, agentDir, IDENTITY_TEMPLATE, readAgentSettings, writeAgentSettings } from "./agents";
import { configPath, displayName, human, readCombConfig, renderTemplate } from "./config";
import { detectHive, HIVE_URL, type HiveSetup } from "./hive";
import { UsageError } from "./errors";
import { ensureCombScaffold, resolveCombHome } from "./paths";

/** Skills comb links into Greg's ~/.claude/skills. */
export const USER_SKILLS = ["comb-handoff"];

/**
 * The comb checkout that holds skills/ and templates/: COMB_REPO, else the
 * current directory when it is a comb checkout (so `comb init` works when run
 * from a fresh clone), else ~/work/comb.
 */
export function resolveCombRepo(cwd: string = process.cwd()): string {
  if (process.env.COMB_REPO) return process.env.COMB_REPO;
  if (existsSync(join(cwd, "templates", "maya-charter.md")) && existsSync(join(cwd, "skills"))) return cwd;
  return join(homedir(), "work", "comb");
}

export type InitResult = { lines: string[] };

export async function combInit(opts: {
  home?: string;
  repo?: string;
  claudeSkillsDir?: string;
  /** Whether hive is on. Detected when omitted. */
  hive?: HiveSetup;
} = {}): Promise<InitResult> {
  const home = opts.home ?? resolveCombHome();
  const repo = opts.repo ?? resolveCombRepo();
  const skillsDir = opts.claudeSkillsDir ?? join(homedir(), ".claude", "skills");
  const lines: string[] = [];

  if (!existsSync(join(repo, "skills"))) {
    throw new UsageError(`comb repo not found at ${repo}. Set COMB_REPO to its path.`);
  }

  await ensureCombScaffold(home);
  lines.push(`home: ${home}`);

  // Read only: init never writes config.json, so an existing install keeps its settings.
  const config = readCombConfig(home, (msg) => lines.push(`config: ${msg}`));
  const hive = opts.hive ?? detectHive({ mode: config.hive });
  lines.push(hive.enabled
    ? `hive: on (${hive.why}): identity, memory, tickets and nightly picks come from hive`
    : `hive: off (${hive.why}). comb runs on plain Claude Code. Install hive for identity, memory, tickets and nightly picks: ${HIVE_URL}`);

  const mayaDir = agentDir("maya", home);
  if (existsSync(join(mayaDir, "charter.md"))) {
    lines.push(`maya: workspace exists, left as is (${mayaDir})`);
  } else {
    const template = await readFile(join(repo, "templates", "maya-charter.md"), "utf-8");
    await createWorkspace(mayaDir, "maya", renderTemplate(template, { human: human(config), hive: hive.enabled }));
    lines.push(`maya: workspace created (${mayaDir})`);
  }

  // Without hive, agents' identity is comb's own file: write the default once,
  // for the user to make theirs. With hive, hive supplies it and this is skipped.
  const identityPath = join(home, "identity.md");
  if (!hive.enabled && !config.identityFile) {
    if (existsSync(identityPath)) {
      lines.push(`identity: ${identityPath} exists, left as is`);
    } else {
      await writeFile(identityPath, IDENTITY_TEMPLATE, "utf-8");
      lines.push(`identity: wrote the default to ${identityPath}; edit it to make it yours`);
    }
  }

  // The chief of staff thinks across everything; she runs on Opus unless
  // Greg's settings.json for her says otherwise.
  const mayaSettings = await readAgentSettings(mayaDir);
  if (!mayaSettings.model) {
    await writeAgentSettings(mayaDir, { ...mayaSettings, model: "opus" });
    lines.push("maya: model set to opus (settings.json)");
  } else {
    lines.push(`maya: model ${mayaSettings.model}`);
  }

  lines.push(`user name: ${displayName(config)} (set "userName" in ${configPath(home)} to change it)`);

  await mkdir(skillsDir, { recursive: true });
  for (const name of USER_SKILLS) {
    const target = join(repo, "skills", name);
    const link = join(skillsDir, name);
    if (!existsSync(link) && !isLink(link)) {
      await symlink(target, link);
      lines.push(`skill ${name}: linked ${link} -> ${target}`);
    } else if (isLink(link) && readlinkSync(link) === target) {
      lines.push(`skill ${name}: already linked`);
    } else {
      lines.push(`skill ${name}: ${link} exists and is not comb's link; left as is`);
    }
  }
  return { lines };
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false; // intentional: missing path
  }
}
