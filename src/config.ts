/**
 * comb's own settings: `<COMB_HOME>/config.json`. Every key is optional.
 *
 *   { "userName": "Ada" }   how the page names the human at the top of the tree
 *
 * This is display only. The human's internal id stays "greg" (GREG in
 * agents.ts): session.json parents, transcripts and queue answers already use
 * it, so changing the name never touches stored state.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveCombHome } from "./paths";

export const DEFAULT_USER_NAME = "You";

export type CombConfig = { userName: string };

/** The human as the page shows them: a name, and the letter in the root avatar. */
export type UserLabel = { name: string; initial: string };

export function configPath(home: string = resolveCombHome()): string {
  return join(home, "config.json");
}

/**
 * Reads config.json. A missing file, bad JSON or a blank value gives the
 * default, so a typo never takes the page down; the page server logs bad JSON.
 */
export function readCombConfig(home: string = resolveCombHome(), onError?: (msg: string) => void): CombConfig {
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(configPath(home), "utf-8"));
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    if (!missing) onError?.(`${configPath(home)} is not valid JSON; using defaults (${err instanceof Error ? err.message : String(err)})`);
  }
  const name = (raw as { userName?: unknown } | null)?.userName;
  return { userName: typeof name === "string" && name.trim() ? name.trim() : DEFAULT_USER_NAME };
}

export function userLabel(config: CombConfig): UserLabel {
  const name = config.userName;
  return { name, initial: [...name][0]!.toUpperCase() };
}
