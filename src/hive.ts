/**
 * comb's only contact with hive. hive is the personalization layer (identity,
 * memory, taste, tickets); comb reads it through stable interfaces and never
 * writes to ~/.hive:
 *   - identity:  `hive identity emit`, run in the agent's directory
 *   - projects:  the registry files ~/.hive/projects/<name>/config.md
 *   - memory and tickets: the `hive` MCP server every Claude session loads
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

import { runProcess, type Run } from "./claude";

export function resolveHiveHome(): string {
  return process.env.HIVE_HOME || join(homedir(), ".hive");
}

export function findHiveBin(): string {
  return process.env.COMB_HIVE_BIN || "hive";
}

/** HIVE identity for a session in `cwd`: soul, Greg, project memory, taste. */
export async function hiveIdentity(cwd: string, run: Run = runProcess): Promise<string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  let res;
  try {
    res = await run([findHiveBin(), "identity", "emit"], { cwd, env });
  } catch (err) {
    throw new Error(`Could not run hive identity emit: ${err instanceof Error ? err.message : String(err)}. Is hive installed?`);
  }
  if (res.code !== 0 || !res.stdout.trim()) {
    throw new Error(`hive identity emit failed (exit ${res.code}): ${res.stderr.trim()}`);
  }
  return res.stdout;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path; // intentional: a missing path simply matches nothing
  }
}

/** The registered hive project whose path holds `dir`; the deepest match wins. */
export function projectForDir(dir: string, hiveHome: string = resolveHiveHome()): string | null {
  const projectsDir = join(hiveHome, "projects");
  if (!existsSync(projectsDir)) return null;
  const target = canonical(dir);
  let best: { name: string; len: number } | null = null;
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let raw: string;
    try {
      raw = readFileSync(join(projectsDir, entry.name, "config.md"), "utf-8");
    } catch {
      continue; // intentional: a project without a readable config is skipped
    }
    const m = raw.match(/^path:\s*(.+)$/m);
    if (!m) continue;
    const base = canonical(m[1]!.trim().replace(/^["']|["']$/g, "").replace(/^~(?=\/)/, homedir()));
    const inside = target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
    if (inside && (!best || base.length > best.len)) best = { name: entry.name, len: base.length };
  }
  return best?.name ?? null;
}
