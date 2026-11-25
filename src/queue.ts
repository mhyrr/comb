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
import type { MemoryWriter } from "./hive";
import { getCombPaths } from "./paths";

export const KINDS = ["proposal", "decision", "review", "blocker"] as const;
export type Kind = (typeof KINDS)[number];
export type Answer = "go" | "no" | "redirect";
export type Status = "open" | "approved" | "declined" | "redirected" | "withdrawn";
const STATUSES: readonly Status[] = ["open", "approved", "declined", "redirected", "withdrawn"];

export type QueueItem = {
  id: string;
  kind: Kind;
  /** The agent or session that filed it; Greg's answer goes back here. */
  from: string;
  title: string;
  /** What the agent does when Greg says go. One sentence. */
  action: string;
  /**
   * What "Not now" changes, when it changes something (a branch stays open, a
   * pick comes back tomorrow). One sentence. Null: the page says nothing
   * happens and the agent hears the reason (design doc 2026-11-17, decision 8a).
   */
  onNo: string | null;
  /** What a redirect is likely to be, when the filer can name it ("Say Redis and it ships Redis"). Null: the page's default line. */
  onRedirect: string | null;
  /**
   * What changes for Greg if he says go, from his side of the screen: what he
   * will see, do or stop doing (D31). Required on a proposal; null on items
   * filed before it existed, and optional on the other kinds.
   */
  changes: string | null;
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
  /**
   * Whether the precedent reached hive memory (D13): "queued <project> <when>",
   * or "not synced: <why>" for the page to flag. Null without hive.
   */
  hiveSync: string | null;
  /**
   * When the item left the queue without an answer from Greg (TK-008): the
   * sweep found the work done or taken, or an agent withdrew it. A withdrawn
   * item is never a precedent and never reaches hive.
   */
  withdrawn: string | null;
  /** Who withdrew it: "sweep", or the agent's name. */
  withdrawnBy: string | null;
  /** Why, in one line. */
  withdrawnWhy: string | null;
  /** The agent's case: why, its recommendation, the evidence. Markdown. */
  body: string;
};

const FIELDS = ["id", "kind", "from", "title", "action", "changes", "onNo", "onRedirect", "project", "ticket", "model", "modelWhy", "status", "created", "answered", "note", "hiveSync", "withdrawn", "withdrawnBy", "withdrawnWhy"] as const;
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
    changes: orNull(f.changes),
    onNo: orNull(f.onNo),
    onRedirect: orNull(f.onRedirect),
    project: orNull(f.project),
    ticket: orNull(f.ticket),
    model: orNull(f.model),
    modelWhy: orNull(f.modelWhy),
    status: (STATUSES as readonly string[]).includes(f.status ?? "") ? (f.status as Status) : "open",
    created: f.created ?? "",
    answered: orNull(f.answered),
    note: orNull(f.note),
    hiveSync: orNull(f.hiveSync),
    withdrawn: orNull(f.withdrawn),
    withdrawnBy: orNull(f.withdrawnBy),
    withdrawnWhy: orNull(f.withdrawnWhy),
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
  /** What "Not now" changes, if anything. One sentence. */
  onNo?: string | null;
  /** What a redirect is likely to say, if the filer can name it. One sentence. */
  onRedirect?: string | null;
  /** What changes for Greg on go, in plain words (D31). Required for a proposal. */
  changes?: string | null;
};

/** The refusal a proposal without `changes` gets (D31): what to write, with one good example. */
export const CHANGES_REQUIRED =
  "A proposal needs `changes`: what changes for Greg if he says go, from his side of the screen. " +
  "Say what he will see, do or stop doing differently, or \"nothing visible\" plus what changes underneath. " +
  "Not the implementation. E.g. \"The queue shows a 'What changes for you' line on every proposal.\"";

export async function addItem(n: NewItem, home?: string, now = new Date()): Promise<QueueItem> {
  if (!(KINDS as readonly string[]).includes(n.kind)) {
    throw new UsageError(`kind must be one of ${KINDS.join(", ")}`);
  }
  if (!oneLine(n.title)) throw new UsageError("Give the item a title: what Greg is saying yes or no to.");
  if (!oneLine(n.action)) throw new UsageError("Say what you will do when Greg says go.");
  const changes = n.changes ? oneLine(n.changes) || null : null;
  if (n.kind === "proposal" && !changes) throw new UsageError(CHANGES_REQUIRED);
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
    changes,
    onNo: n.onNo ? oneLine(n.onNo) || null : null,
    onRedirect: n.onRedirect ? oneLine(n.onRedirect) || null : null,
    project: n.project?.trim() || null,
    ticket: n.ticket?.trim() || null,
    model,
    modelWhy: model ? (n.modelWhy ? oneLine(n.modelWhy) || null : null) : null,
    status: "open",
    created: now.toISOString(),
    answered: null,
    note: null,
    hiveSync: null,
    withdrawn: null,
    withdrawnBy: null,
    withdrawnWhy: null,
    body: n.body?.trim() ?? "",
  };
  await mkdir(join(queueDir, id, "evidence"), { recursive: true });
  await writeFile(join(queueDir, id, "item.md"), serializeItem(item), "utf-8");
  return item;
}

/** When an item left the open queue: Greg's answer, or its withdrawal. */
export const closedAt = (i: Pick<QueueItem, "answered" | "withdrawn">): string | null => i.answered ?? i.withdrawn;

/** Open items, then answered and withdrawn ones from the last `answeredWithinMs`, newest first. */
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
      const closed = closedAt(item);
      if (item.status === "open" || (closed && now - Date.parse(closed) < answeredWithinMs)) out.push(item);
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
 * Takes an open item out of the queue without an answer from Greg (TK-008):
 * the work is done, or it was taken elsewhere. It writes no precedent and
 * sends nothing to hive or to the filer. The page folds it into "Withdrawn".
 */
export async function withdrawItem(id: string, reason: string, by: string, home?: string, now = new Date()): Promise<QueueItem> {
  const why = oneLine(reason);
  if (!why) throw new UsageError("Give the reason it is withdrawn, in one line.");
  const item = await readItem(id, home);
  if (item.status === "withdrawn") throw new UsageError(`Already withdrawn: ${item.withdrawnWhy ?? "no reason recorded"}.`);
  if (item.status !== "open") throw new UsageError(`Greg already answered it (${item.status}), so it stays.`);
  item.status = "withdrawn";
  item.withdrawn = now.toISOString();
  item.withdrawnBy = oneLine(by) || "unknown";
  item.withdrawnWhy = why.slice(0, 300);
  await writeFile(join(getCombPaths(home).queueDir, id, "item.md"), serializeItem(item), "utf-8");
  return item;
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

/** Where a precedent goes in hive memory, and through what. Null when hive is off (D24). */
export type PrecedentSink = {
  writer: MemoryWriter;
  /** hive's registered projects; an item outside them is scoped to comb. */
  projects: string[];
  /** Ms before a hung hive counts as a failed sync. */
  timeoutMs?: number;
};

export type SyncResult = { ok: true; project: string } | { ok: false; error: string };

/**
 * Records Greg's answer and his precedent. The page calls it before it
 * delivers the answer, so a failed delivery never loses it. With `hive`, it also
 * queues the precedent in hive memory (D13). A hive failure never fails the
 * answer: it is logged, and the item and the precedent say it was not synced.
 */
export async function recordAnswer(
  id: string, answer: Answer, note: string | null, home?: string, now = new Date(), model: string | null = null,
  hive: PrecedentSink | null = null,
): Promise<QueueItem> {
  const item = await readItem(id, home);
  // A withdrawal is not an answer: Greg's answer, if it raced the sweep, still counts and replaces it.
  if (item.status !== "open" && item.status !== "withdrawn") throw new UsageError(`Already answered (${item.status}).`);
  item.withdrawn = item.withdrawnBy = item.withdrawnWhy = null;
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
    `- Greg: ${answerWord(answer)}`,
    ...(answer === "go" && model
      ? [`- Model: ${model}${proposedModel && proposedModel !== model ? ` (${item.from} proposed ${proposedModel})` : ""}`]
      : []),
    item.note ? `- Why: ${item.note}` : "- Why: (no reason given)",
    `- When: ${item.answered}`,
    "",
  ].join("\n");
  await writeFile(join(paths.precedentsDir, `${id}.md`), precedent, "utf-8");
  if (hive) await syncPrecedent(item, hive, home, now);
  return item;
}

const answerWord = (a: Answer) => (a === "go" ? "go" : a === "no" ? "not now" : "redirect");

/** The answer an answered item holds; null while it is open. */
export function answerOf(item: QueueItem): Answer | null {
  if (item.status === "approved") return "go";
  if (item.status === "declined") return "no";
  if (item.status === "redirected") return "redirect";
  return null;
}

/** hive caps an entry at 1000 characters and refuses "## " (a section header). */
const MAX_ENTRY = 1000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const safe = (s: string) => oneLine(s).replace(/#{2,}\s/g, "# ");

/**
 * The precedent as one hive memory entry: a decision a later agent can act on.
 * E.g. `Greg declined maya's proposal "Start instadash on TK-009" (instadash
 * TK-009) on 2026-11-18: not now. Proposed: … Reason: …`
 */
export function precedentEntry(item: QueueItem): string {
  const answer = answerOf(item);
  if (!answer) throw new Error(`queue item ${item.id} is not answered`);
  const verb = answer === "go" ? "approved" : answer === "no" ? "declined" : "redirected";
  const where = [item.project, item.ticket].filter(Boolean).join(" ");
  const day = localDay(item.answered);
  const said = answer === "go" && item.model && picksModel(item) ? `go (model: ${item.model})` : answerWord(answer);
  const head = `Greg ${verb} ${item.from}'s ${item.kind} "${safe(item.title)}"${where ? ` (${where})` : ""} on ${day}: ${said}.`;
  const reason = item.note ? safe(item.note) : "";
  const tail = answer === "redirect" ? ` Do this instead: ${reason}` : reason ? ` Reason: ${reason}` : " No reason given.";
  const proposed = ` Proposed: ${safe(item.action)}`;
  // The decision and the reason stay whole; the proposed action gives way first.
  const room = MAX_ENTRY - head.length - tail.length;
  if (room >= 20) return head + clip(proposed, room) + tail;
  return clip(head + tail, MAX_ENTRY);
}

/** The day Greg answered, on his own clock (the machine's time zone), as YYYY-MM-DD. */
function localDay(iso: string | null): string {
  const d = new Date(iso ?? "");
  if (Number.isNaN(d.getTime())) return "an unknown day";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The project the entry is scoped to: the item's when hive knows it, else comb. */
export function precedentProject(item: QueueItem, projects: string[]): string {
  return item.project && projects.includes(item.project) ? item.project : "comb";
}

const SYNC_LINE = /^- Hive memory: .*$/m;

/** Whether a precedent file says it already went to hive memory. */
export function precedentSynced(text: string): boolean {
  return /^- Hive memory: queued /m.test(text);
}

/**
 * Queues one answered item's precedent in hive memory, then records the
 * outcome in comb's own files: a "- Hive memory:" line in the precedent and
 * the item's hiveSync field. A hive failure is logged and recorded, never thrown.
 */
export async function syncPrecedent(item: QueueItem, hive: PrecedentSink, home?: string, now = new Date()): Promise<SyncResult> {
  const paths = getCombPaths(home);
  const project = precedentProject(item, hive.projects);
  let result: SyncResult;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const content = precedentEntry(item);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("hive did not answer in time")), hive.timeoutMs ?? 20_000);
    });
    await Promise.race([
      hive.writer.writeMemory({
        project,
        type: "decision",
        content,
        tags: ["precedent", "queue"],
        provenanceNote: `Greg's answer on comb's page to queue item ${item.id}, filed by ${item.from}. From comb's precedents/${item.id}.md.`,
        // A queue answer is Greg's own call, not an agent's judgment: the verifier may place it, not drop it.
        directive: true,
      }),
      timeout,
    ]);
    result = { ok: true, project };
  } catch (err) {
    result = { ok: false, error: oneLine(err instanceof Error ? err.message : String(err)).slice(0, 300) || "unknown error" };
    console.error(`comb: precedent ${item.id} was not synced to hive memory: ${result.error}`);
  } finally {
    clearTimeout(timer);
  }
  const at = now.toISOString();
  item.hiveSync = result.ok ? `queued ${result.project} ${at}` : `not synced: ${result.error}`;
  const line = result.ok
    ? `- Hive memory: queued as a decision in ${result.project} at ${at}`
    : `- Hive memory: not synced at ${at} (${result.error}). Retry: comb precedents sync`;
  try {
    await writeFile(join(paths.queueDir, item.id, "item.md"), serializeItem(item), "utf-8");
    const file = join(paths.precedentsDir, `${item.id}.md`);
    const text = existsSync(file) ? await readFile(file, "utf-8") : "";
    const next = SYNC_LINE.test(text) ? text.replace(SYNC_LINE, line) : `${text.replace(/\n*$/, "\n")}${line}\n`;
    await writeFile(file, next, "utf-8");
  } catch (err) {
    console.error(`comb: could not record the hive sync of precedent ${item.id}:`, err);
  }
  return result;
}

export type SyncReport = {
  synced: string[];
  /** Already in hive memory, so left alone. */
  already: string[];
  failed: { id: string; error: string }[];
  skipped: { id: string; why: string }[];
  /** A dry run's would-be writes. */
  planned: { id: string; project: string; entry: string }[];
};

/**
 * The backfill (`comb precedents sync`): each precedent not yet in hive memory,
 * once. Idempotent: a precedent whose file says "queued" is left alone. A dry
 * run writes nothing and lists the entries it would send.
 */
export async function syncAllPrecedents(hive: PrecedentSink, o: { home?: string; dryRun?: boolean; now?: Date } = {}): Promise<SyncReport> {
  const paths = getCombPaths(o.home);
  const out: SyncReport = { synced: [], already: [], failed: [], skipped: [], planned: [] };
  if (!existsSync(paths.precedentsDir)) return out;
  const ids = readdirSync(paths.precedentsDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  for (const id of ids) {
    if (precedentSynced(await readFile(join(paths.precedentsDir, `${id}.md`), "utf-8"))) {
      out.already.push(id);
      continue;
    }
    let item: QueueItem;
    try {
      item = await readItem(id, o.home);
    } catch {
      out.skipped.push({ id, why: "no queue item to build the entry from" });
      continue;
    }
    if (!answerOf(item)) {
      out.skipped.push({ id, why: "the item is still open" });
      continue;
    }
    if (o.dryRun) {
      out.planned.push({ id, project: precedentProject(item, hive.projects), entry: precedentEntry(item) });
      continue;
    }
    const r = await syncPrecedent(item, hive, o.home, o.now);
    if (r.ok) out.synced.push(id);
    else out.failed.push({ id, error: r.error });
  }
  return out;
}

/** The backfill's report, for the terminal. */
export function formatSyncReport(r: SyncReport, dryRun: boolean): string {
  const lines: string[] = [];
  if (dryRun) {
    lines.push(`Would queue ${r.planned.length} precedent(s) in hive memory:`);
    for (const p of r.planned) lines.push(`  ${p.id} -> ${p.project}: ${p.entry}`);
  } else {
    lines.push(`Queued ${r.synced.length} precedent(s) in hive memory as decision candidates; hive's nightly verifier admits them.`);
  }
  lines.push(`Already synced: ${r.already.length}.`);
  for (const s of r.skipped) lines.push(`Skipped ${s.id}: ${s.why}.`);
  if (r.failed.length) {
    lines.push(`Not synced: ${r.failed.length}. Run it again to retry.`);
    for (const f of r.failed) lines.push(`  ${f.id}: ${f.error}`);
  }
  return lines.join("\n");
}
