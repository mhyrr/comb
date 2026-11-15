/**
 * comb's own settings: `<COMB_HOME>/config.json`. Every key is optional.
 *
 *   {
 *     "userName": "Ada",          the human's name, on the page and in agents' instructions
 *     "hive": "auto",             "auto" (use hive when installed), "on" (require it), "off"
 *     "identityFile": "~/me.md",  the identity agents get when hive is off
 *     "nightlyAsks": false,       file hive's briefing asks into the queue (§9.3; off by default)
 *     "defaultModel": "opus",     the model for delegated work when none is named (D25)
 *     "foldAfterHours": 24        idle hours before finished work folds on the page (D22)
 *   }
 *
 * The human's internal id stays "greg" (GREG in agents.ts) whatever the name:
 * session.json parents, transcripts and queue answers already use it.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_MODEL, isModel, MODELS, type Model } from "./models";
import { resolveCombHome } from "./paths";

/** What the page calls the human when no userName is set. */
export const DEFAULT_USER_NAME = "You";

export type HiveMode = "auto" | "on" | "off";
export const HIVE_MODES: readonly HiveMode[] = ["auto", "on", "off"];

export type CombConfig = {
  /** null when unset: the page says "You" and agents' instructions say "the user". */
  userName: string | null;
  hive: HiveMode;
  /** Absolute path, with ~ expanded; null when unset. */
  identityFile: string | null;
  /** File the briefing's "What needs your attention" asks with hive's picks. Off unless set to true. */
  nightlyAsks: boolean;
  /** The model agent_start and the queue's picker use when none is named: one of MODELS, "opus" unless set. */
  defaultModel: Model;
  /** Idle hours before a finished agent, or one of the human's sessions, folds on the page (D22). */
  foldAfterHours: number;
};

/** The page folds finished work after one idle day unless foldAfterHours says otherwise. */
export const DEFAULT_FOLD_AFTER_HOURS = 24;

/** The human as the page shows them: a name, and the letter in the root avatar. */
export type UserLabel = { name: string; initial: string };

export function configPath(home: string = resolveCombHome()): string {
  return join(home, "config.json");
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Reads config.json. A missing file, bad JSON or a bad value gives the
 * default, so a typo never takes the page down; `onError` hears about it.
 * COMB_HIVE overrides "hive" (for tests and one-off runs).
 */
export function readCombConfig(home: string = resolveCombHome(), onError?: (msg: string) => void): CombConfig {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(configPath(home), "utf-8"));
    if (parsed && typeof parsed === "object") raw = parsed;
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    if (!missing) onError?.(`${configPath(home)} is not valid JSON; using defaults (${err instanceof Error ? err.message : String(err)})`);
  }
  let hive: HiveMode = "auto";
  const wanted = process.env.COMB_HIVE || raw.hive;
  if (wanted !== undefined) {
    if ((HIVE_MODES as readonly unknown[]).includes(wanted)) hive = wanted as HiveMode;
    else onError?.(`"hive" must be one of ${HIVE_MODES.join(", ")}; using auto`);
  }
  const file = str(raw.identityFile);
  if (raw.nightlyAsks !== undefined && typeof raw.nightlyAsks !== "boolean") onError?.('"nightlyAsks" must be true or false; using false');
  if (raw.defaultModel !== undefined && !isModel(raw.defaultModel)) {
    onError?.(`"defaultModel" must be one of ${MODELS.join(", ")}; using ${DEFAULT_MODEL}`);
  }
  const fold = raw.foldAfterHours;
  const foldOk = typeof fold === "number" && Number.isFinite(fold) && fold > 0;
  if (fold !== undefined && !foldOk) onError?.(`"foldAfterHours" must be a positive number; using ${DEFAULT_FOLD_AFTER_HOURS}`);
  return {
    userName: str(raw.userName),
    hive,
    identityFile: file ? file.replace(/^~(?=\/|$)/, process.env.HOME || homedir()) : null,
    nightlyAsks: raw.nightlyAsks === true,
    defaultModel: isModel(raw.defaultModel) ? raw.defaultModel : DEFAULT_MODEL,
    foldAfterHours: foldOk ? fold : DEFAULT_FOLD_AFTER_HOURS,
  };
}

export function displayName(config: CombConfig): string {
  return config.userName ?? DEFAULT_USER_NAME;
}

export function userLabel(config: CombConfig): UserLabel {
  const name = displayName(config);
  return { name, initial: [...name][0]!.toUpperCase() };
}

/** How agents' instructions name the human: mid-sentence and at a sentence start. */
export type Human = { name: string; Name: string };

export function human(config: CombConfig): Human {
  return config.userName ? { name: config.userName, Name: config.userName } : { name: "the user", Name: "The user" };
}

/**
 * Fills a template from templates/: `{{user}}` and `{{User}}` with the
 * human's name, and keeps `{{#hive}}…{{/hive}}` blocks only with hive and
 * `{{^hive}}…{{/hive}}` blocks only without it.
 */
export function renderTemplate(text: string, o: { human: Human; hive: boolean }): string {
  return text
    .replace(/\{\{([#^])hive\}\}\n?([\s\S]*?)\{\{\/hive\}\}\n?/g, (_, kind: string, body: string) => ((kind === "#") === o.hive ? body : ""))
    .replaceAll("{{user}}", o.human.name)
    .replaceAll("{{User}}", o.human.Name);
}
