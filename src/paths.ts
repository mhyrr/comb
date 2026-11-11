import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** comb's own state. hive's ~/.hive is read, never written. */
export function resolveCombHome(): string {
  return process.env.COMB_HOME || join(homedir(), ".comb");
}

export type CombPaths = { home: string; agentsDir: string; queueDir: string; precedentsDir: string };

export function getCombPaths(home: string = resolveCombHome()): CombPaths {
  return {
    home,
    agentsDir: join(home, "agents"),
    queueDir: join(home, "queue"),
    precedentsDir: join(home, "precedents"),
  };
}

export async function ensureCombScaffold(home: string = resolveCombHome()): Promise<CombPaths> {
  const paths = getCombPaths(home);
  for (const dir of [paths.agentsDir, paths.queueDir, paths.precedentsDir]) {
    await mkdir(dir, { recursive: true });
  }
  return paths;
}
