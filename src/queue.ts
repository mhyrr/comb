/**
 * The queue: what waits on Greg (design §9). An agent files an item with
 * `queue_add`; Greg answers it on the page; the answer goes back to the agent
 * as a message, and into precedents/ with his reason.
 *
 * Each item is a folder Greg can read: ~/.comb/queue/<id>/item.md, a block of
 * `key: value` lines between --- fences, then the agent's case in Markdown.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { UsageError } from "./errors";
import { isModel, MODELS, picksModel } from "./models";
import { getCombPaths } from "./paths";

export const KINDS = ["proposal", "decision", "review", "blocker"] as const;
export type Kind = (typeof KINDS)[number];
export type Answer = "go" | "no" | "redirect";
export type Status = "open" | "approved" | "declined" | "redirected";

export type QueueItem = {
  id: string;
  kind: Kind;
  /** The agent or session that filed it; Greg's answer goes back here. */
  from: string;
  title: string;
  /** What the agent does when Greg says go. One sentence. */
  action: string;
  project: string | null;
  ticket: string | null;
  status: Status;
  created: string;
  answered: string | null;
  /** Greg's reason or redirection, if he gave one. */
  note: string | null;
  /**
   * The model for the work go starts (D25): the filer's pick while open,
   * Greg's pick once he says go. Null means config.json's defaultModel.
   */
  model: string | null;
  /** The filer's one-line reason for its model pick. */
  modelWhy: string | null;
  /** The agent's case: why, its recommendation, the evidence. Markdown. */
  body: string;
};

const FIELDS = ["id", "kind", "from", "title", "action", "project", "ticket", "model", "modelWhy", "status", "created", "answered", "note"] as const;
export { picksModel };

/**
 * The model a go carries (D25): Greg's pick, else the filer's, else
 * config.json's default. Null for an answer that starts nothing.
 */
export function answerModel(item: QueueItem, answer: Answer, picked: string | null, defaultModel: string): string | null {
  if (answer !== "go" || !picksModel(item)) return null;
  return picked ?? item.model ?? defaultModel;
}
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function serializeItem(item: QueueItem): string {
  const head = FIELDS.map((k) => `${k}: ${oneLine(String(item[k] ?? ""))}`).join("\n");
  return `---\n${head}\n---\n\n${item.body.trim()}\n`;
}

export function parseItem(text: string): QueueItem {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error("queue item has no --- header");
  const f: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^(\w+):\s?(.*)$/);
    if (kv) f[kv[1]!] = kv[2]!.trim();
  }
  const orNull = (v: string | undefined) => (v ? v : null);
  return {
    id: f.id ?? "",
    kind: (KINDS as readonly string[]).includes(f.kind ?? "") ? (f.kind as Kind) : "proposal",
    from: f.from ?? "",
    title: f.title ?? "",
    action: f.action ?? "",
    project: orNull(f.project),
    ticket: orNull(f.ticket),
    model: orNull(f.model),
    modelWhy: orNull(f.modelWhy),
    status: (["open", "approved", "declined", "redirected"].includes(f.status ?? "") ? f.status : "open") as Status,
    created: f.created ?? "",
    answered: orNull(f.answered),
    note: orNull(f.note),
    body: m[2]!.trim(),
  };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "item";
}

export type NewItem = {
  kind: string;
  from: string;
  title: string;
  action: string;
  body?: string;
  project?: string | null;
  ticket?: string | null;
  /** One of MODELS, for an item whose go starts work. */
  model?: string | null;
  modelWhy?: string | null;
};

export async function addItem(n: NewItem, home?: string, now = new Date()): Promise<QueueItem> {
  if (!(KINDS as readonly string[]).includes(n.kind)) {
    throw new UsageError(`kind must be one of ${KINDS.join(", ")}`);
  }
  if (!oneLine(n.title)) throw new UsageError("Give the item a title: what Greg is saying yes or no to.");
  if (!oneLine(n.action)) throw new UsageError("Say what you will do when Greg says go.");
  const model = n.model?.trim() || null;
  if (model && !isModel(model)) throw new UsageError(`model must be one of ${MODELS.join(", ")}`);
  if (model && (n.kind === "decision" || n.kind === "blocker")) {
    throw new UsageError(`A ${n.kind} starts no work, so it takes no model. Leave model off.`);
  }
  const { queueDir } = getCombPaths(home);
  const stamp = now.toISOString().slice(0, 10);
  let id = `${stamp}-${slug(n.title)}`;
  for (let i = 2; existsSync(join(queueDir, id)); i++) id = `${stamp}-${slug(n.title)}-${i}`;
  const item: QueueItem = {
    id,
    kind: n.kind as Kind,
    from: n.from,
    title: oneLine(n.title),
    action: oneLine(n.action),
    project: n.project?.trim() || null,
    ticket: n.ticket?.trim() || null,
    model,
    modelWhy: model ? (n.modelWhy ? oneLine(n.modelWhy) || null : null) : null,
    status: "open",
    created: now.toISOString(),
    answered: null,
    note: null,
    body: n.body?.trim() ?? "",
  };
  await mkdir(join(queueDir, id, "evidence"), { recursive: true });
  await writeFile(join(queueDir, id, "item.md"), serializeItem(item), "utf-8");
  return item;
}

/** Open items, then answered ones from the last `answeredWithinMs`, newest first. */
export async function listItems(home?: string, answeredWithinMs = 24 * 3600_000, now = Date.now()): Promise<QueueItem[]> {
  const { queueDir } = getCombPaths(home);
  if (!existsSync(queueDir)) return [];
  const out: QueueItem[] = [];
  for (const e of readdirSync(queueDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const path = join(queueDir, e.name, "item.md");
    if (!existsSync(path)) continue;
    try {
      const item = parseItem(await readFile(path, "utf-8"));
      if (!item.id) item.id = e.name;
      if (item.status === "open" || (item.answered && now - Date.parse(item.answered) < answeredWithinMs)) out.push(item);
    } catch {
      continue; // intentional: a hand-mangled item is skipped, not fatal to the page
    }
  }
  return out.sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || b.created.localeCompare(a.created));
}

export async function readItem(id: string, home?: string): Promise<QueueItem> {
  if (!/^[a-z0-9-]+$/.test(id)) throw new UsageError("No such queue item.");
  const path = join(getCombPaths(home).queueDir, id, "item.md");
  if (!existsSync(path)) throw new UsageError("No such queue item.");
  return parseItem(await readFile(path, "utf-8"));
}

/**
 * The message the asking agent gets. `model` is Greg's pick on a go that
 * starts work (picksModel); the message names it, and says to start with it.
 */
export function answerMessage(item: QueueItem, answer: Answer, note: string | null, model: string | null = null): string {
  const ref = `your ${item.kind} "${item.title}" (queue item ${item.id})`;
  if (answer === "go") {
    const run = model ? `\n\nRun the work on ${model}: pass model "${model}" to agent_start.` : "";
    return `Greg approved ${ref}. Go${model ? ` (model: ${model})` : ""}: ${item.action}${run}${note ? `\n\nHis note: ${note}` : ""}`;
  }
  if (answer === "no") {
    return `Greg said not now to ${ref}. Do not do it.${note ? `\n\nHis reason: ${note}` : ""}`;
  }
  return `Greg redirected ${ref}. Do this instead: ${note}`;
}

/**
 * Records Greg's answer and his precedent. Call after the message reached the
 * agent, so an undelivered answer leaves the item open.
 */
export async function recordAnswer(
  id: string, answer: Answer, note: string | null, home?: string, now = new Date(), model: string | null = null,
): Promise<QueueItem> {
  const item = await readItem(id, home);
  if (item.status !== "open") throw new UsageError(`Already answered (${item.status}).`);
  const paths = getCombPaths(home);
  const proposedModel = item.model;
  item.status = answer === "go" ? "approved" : answer === "no" ? "declined" : "redirected";
  item.answered = now.toISOString();
  item.note = note?.trim() || null;
  if (answer === "go" && model) item.model = model;
  await writeFile(join(paths.queueDir, id, "item.md"), serializeItem(item), "utf-8");
  await mkdir(paths.precedentsDir, { recursive: true });
  const precedent = [
    `# ${item.title}`,
    "",
    `- Asked by: ${item.from} (${item.kind}${item.project ? `, ${item.project}` : ""}${item.ticket ? ` ${item.ticket}` : ""})`,
    `- Proposed: ${item.action}`,
    `- Greg: ${answer === "go" ? "go" : answer === "no" ? "not now" : "redirect"}`,
    ...(answer === "go" && model
      ? [`- Model: ${model}${proposedModel && proposedModel !== model ? ` (${item.from} proposed ${proposedModel})` : ""}`]
      : []),
    item.note ? `- Why: ${item.note}` : "- Why: (no reason given)",
    `- When: ${item.answered}`,
    "",
  ].join("\n");
  await writeFile(join(paths.precedentsDir, `${id}.md`), precedent, "utf-8");
  return item;
}
