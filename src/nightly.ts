/**
 * hive's nightly asks, filed into comb's queue (design §9.3, D22).
 *
 * hive writes two things Greg should act on: the Act watches' picks in
 * ~/.hive/next.json (one ticket per project) and the briefing's "What needs
 * your attention" list. comb reads both, read-only, and files each new one as
 * a queue item from Maya: a pick as a proposal to start a task agent, an ask as
 * a decision. hive never learns that comb exists.
 *
 * Every run is safe to repeat. ~/.comb/nightly/filed.json records each item
 * filed, keyed by project+ticket+selectedAt for a pick and date+text for an
 * ask, so nothing is filed twice.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { listHiveProjects, parseAttention, readActPicks, readBriefing, readTicketFile, resolveHiveHome, type ActPick } from "./hive";
import { getCombPaths, resolveCombHome } from "./paths";
import { addItem, listItems, type QueueItem } from "./queue";

/** Who files hive's items: Greg's answer goes to her (D21: she starts the task agents). */
export const NIGHTLY_FROM = "maya";
export const MAX_ITEMS_PER_NIGHT = 10;
export const STALE_PICK_DAYS = 7;
/** How often the page server runs this. hive writes picks at varied hours. */
export const NIGHTLY_EVERY_MS = 3600_000;
const KEEP_RECORD_DAYS = 30;
const DAY_MS = 24 * 3600_000;
const CLOSED = new Set(["closed", "done"]);

export type NightlyOpts = {
  home?: string;
  hiveHome?: string;
  now?: Date;
  /** Report what would be filed; write nothing. */
  dryRun?: boolean;
  maxItems?: number;
};

type Planned = {
  key: string;
  label: string;
  kind: "proposal" | "decision";
  project: string | null;
  ticket: string | null;
  title: string;
  action: string;
  body: string;
};

export type NightlyLine = { label: string; title?: string; reason?: string; id?: string };
export type NightlyReport = {
  date: string;
  dryRun: boolean;
  filed: NightlyLine[];
  deferred: NightlyLine[];
  skipped: NightlyLine[];
  /** Why there is nothing from the briefing, when there is no briefing. */
  briefing: string | null;
};

type Filed = { at: string; date: string; id: string; kind: "pick" | "ask"; project: string | null };
type State = { filed: { [key: string]: Filed } };

/** YYYY-MM-DD in local time, the way hive names its briefings. */
export function localDate(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

export function stateFile(home: string = resolveCombHome()): string {
  return join(getCombPaths(home).home, "nightly", "filed.json");
}

async function loadState(path: string): Promise<State> {
  if (!existsSync(path)) return { filed: {} };
  const raw = JSON.parse(await readFile(path, "utf-8")) as Partial<State>;
  return { filed: raw.filed ?? {} };
}

async function saveState(path: string, state: State): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  await rename(tmp, path);
}

export const agentNameFor = (project: string, ticket: string) => `${project}-${ticket.toLowerCase()}`;

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
const ticketRe = (t: string) => new RegExp(`(^|[^\\w-])${t.replace(/[^\w-]/g, "")}(?![\\w-])`, "i");

/** An open queue item about the same ticket: its ticket field, or the id in its title. */
function openDuplicate(open: QueueItem[], project: string | null, ticket: string | null, title: string): QueueItem | null {
  return (
    open.find((i) => {
      if (title && normalize(i.title).toLowerCase() === normalize(title).toLowerCase()) return true;
      if (!ticket) return false;
      const sameProject = !project || !i.project || i.project === project;
      return sameProject && (i.ticket?.toUpperCase() === ticket.toUpperCase() || ticketRe(ticket).test(i.title));
    }) ?? null
  );
}

/** The project and ticket an attention item is about, if it names them. */
export function askSubject(text: string, projects: string[]): { project: string | null; ticket: string | null } {
  const lead = text.match(/^\*\*(.+?)\*\*/)?.[1] ?? text.split(/[.:]/)[0] ?? "";
  const words = lead.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
  const project = words.find((w) => projects.includes(w)) ?? null;
  const ticket = text.match(/\bTK-\d+\b/)?.[0] ?? null;
  return { project, ticket };
}

function askTitle(text: string): string {
  const plain = normalize(text.replace(/\*\*/g, ""));
  if (plain.length <= 160) return plain;
  return plain.slice(0, 160).replace(/\s+\S*$/, "") + "…";
}

function planPick(p: ActPick, ticket: { status: string; title: string; priority: string | null; type: string | null }): Omit<Planned, "key" | "label"> {
  const agent = agentNameFor(p.project, p.ticket);
  const meta = [ticket.status, ticket.priority ? `P${ticket.priority}` : null, ticket.type].filter(Boolean).join(", ");
  return {
    kind: "proposal",
    project: p.project,
    ticket: p.ticket,
    title: `Start ${p.project} ${p.ticket}: ${ticket.title || "(untitled)"}`,
    action: `Maya starts task agent ${agent} on ${p.project} ${p.ticket}.`,
    body: [
      `hive's nightly Act watch \`${p.source}\` picked this ticket at ${p.selectedAt}. On go, Maya starts task agent \`${agent}\` on it with the ticket, its context, and where the docs and memory are (D21).`,
      "",
      `**${p.ticket}** (${meta}): ${ticket.title}`,
      "",
      "## hive's rationale",
      "",
      p.rationale.trim() || "(none given)",
    ].join("\n"),
  };
}

/** Reads hive's nightly outputs and files what is new into the queue. */
export async function runNightly(opts: NightlyOpts = {}): Promise<NightlyReport> {
  const home = opts.home ?? resolveCombHome();
  const hiveHome = opts.hiveHome ?? resolveHiveHome();
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;
  const max = opts.maxItems ?? MAX_ITEMS_PER_NIGHT;
  const today = localDate(now);
  const path = stateFile(home);
  const state = await loadState(path);
  for (const [k, r] of Object.entries(state.filed)) {
    if (now.getTime() - Date.parse(r.at) > KEEP_RECORD_DAYS * DAY_MS) delete state.filed[k];
  }
  const open = (await listItems(home, 0, now.getTime())).filter((i) => i.status === "open");
  const report: NightlyReport = { date: today, dryRun, filed: [], deferred: [], skipped: [], briefing: null };
  const filedTonight = Object.values(state.filed).filter((r) => r.date === today);
  /**
   * The same ticket or ask text filed in the last week. hive re-picks a ticket
   * with a new selectedAt (twice on 2026-11-13), and a briefing can repeat an
   * ask; neither should come back to Greg once he has seen it.
   */
  const recent = (match: (key: string) => boolean): Filed | undefined =>
    Object.entries(state.filed).find(([k, r]) => match(k) && now.getTime() - Date.parse(r.at) < STALE_PICK_DAYS * DAY_MS)?.[1];

  // Picks: the newest per project, then the skip rules in order.
  const picks: Planned[] = [];
  /** Current picks Greg has or will have in front of him; an ask about one of them is a duplicate. */
  const current: { project: string; ticket: string; label: string }[] = [];
  const newest = new Map<string, ActPick>();
  for (const p of readActPicks(hiveHome)) {
    const seen = newest.get(p.project);
    if (!seen || p.selectedAt > seen.selectedAt) newest.set(p.project, p);
  }
  for (const p of [...newest.values()].sort((a, b) => b.selectedAt.localeCompare(a.selectedAt))) {
    const label = `${p.project} ${p.ticket}`;
    const key = `pick:${p.project}:${p.ticket}:${p.selectedAt}`;
    const days = Math.floor((now.getTime() - Date.parse(p.selectedAt)) / DAY_MS);
    const ticket = readTicketFile(p.project, p.ticket, hiveHome);
    const dup = ticket ? openDuplicate(open, p.project, p.ticket, "") : null;
    const earlier = state.filed[key] ?? recent((k) => k.startsWith(`pick:${p.project}:${p.ticket}:`));
    let reason: string | null = null;
    if (earlier) reason = `already filed ${earlier.date} (${earlier.id})`;
    else if (days > STALE_PICK_DAYS) reason = `stale: picked ${p.selectedAt.slice(0, 10)}, ${days} days ago`;
    else if (!ticket) reason = `hive has no ticket ${p.project}/${p.ticket}`;
    else if (CLOSED.has(ticket.status)) reason = `ticket is ${ticket.status}`;
    else if (dup) reason = `already open in the queue: ${dup.id}`;
    else if (filedTonight.some((r) => r.kind === "pick" && r.project === p.project)) reason = "one pick per project a night; this project's is filed";
    if (ticket && !CLOSED.has(ticket.status) && days <= STALE_PICK_DAYS) current.push({ project: p.project, ticket: p.ticket, label });
    if (reason) report.skipped.push({ label, reason });
    else picks.push({ key, label, ...planPick(p, ticket!) });
  }

  // Asks: today's briefing only. Yesterday's asks are yesterday's.
  const asks: Planned[] = [];
  const briefing = readBriefing(today, hiveHome);
  if (briefing === null) report.briefing = `no briefing for ${today} yet`;
  const projects = listHiveProjects(hiveHome);
  parseAttention(briefing ?? "").forEach((text, i) => {
    const label = `ask ${i + 1}`;
    const key = `ask:${today}:${normalize(text)}`;
    const { project, ticket } = askSubject(text, projects);
    const title = askTitle(text);
    const covered = ticket && current.find((p) => p.ticket === ticket && (!project || p.project === project));
    const dup = openDuplicate(open, project, ticket, title);
    const earlier = state.filed[key] ?? recent((k) => k.startsWith("ask:") && k.slice(15) === normalize(text));
    let reason: string | null = null;
    if (earlier) reason = `already filed ${earlier.date} (${earlier.id})`;
    else if (covered) reason = `covered by hive's pick ${covered.label}`;
    else if (dup) reason = `already open in the queue: ${dup.id}`;
    if (reason) {
      report.skipped.push({ label, title, reason });
      return;
    }
    asks.push({
      key,
      label,
      kind: "decision",
      project,
      ticket,
      title,
      action: "Maya acts on Greg's answer and reports back.",
      body: [
        `From hive's briefing for ${today}, "What needs your attention" item ${i + 1}:`,
        "",
        `> ${normalize(text)}`,
        "",
        "Go tells Maya to carry it out as written. Redirect gives her your answer to act on.",
      ].join("\n"),
    });
  });

  // Asks first: a pick that misses the cap comes back tomorrow if still current;
  // an ask does not, so it gets the room.
  let room = Math.max(0, max - filedTonight.length);
  for (const item of [...asks, ...picks]) {
    if (room <= 0) {
      report.deferred.push({
        label: item.label,
        title: item.title,
        reason: item.kind === "proposal" ? `over ${max} a night; refiled tomorrow if hive still picks it` : `over ${max} a night; dropped, tomorrow's briefing carries what still matters`,
      });
      continue;
    }
    room--;
    if (dryRun) {
      report.filed.push({ label: item.label, title: item.title });
      continue;
    }
    const filed = await addItem(
      { kind: item.kind, from: NIGHTLY_FROM, title: item.title, action: item.action, body: item.body, project: item.project, ticket: item.ticket },
      home,
      now,
    );
    state.filed[item.key] = { at: now.toISOString(), date: today, id: filed.id, kind: item.kind === "proposal" ? "pick" : "ask", project: item.project };
    await saveState(path, state);
    report.filed.push({ label: item.label, title: item.title, id: filed.id });
  }
  if (!dryRun) await saveState(path, state);
  return report;
}

export function formatNightly(r: NightlyReport): string {
  const out: string[] = [`hive nightly → comb queue, ${r.date}${r.dryRun ? " (dry run: nothing written)" : ""}`];
  const section = (head: string, lines: NightlyLine[], show: (l: NightlyLine) => string) => {
    if (!lines.length) return;
    out.push("", head);
    for (const l of lines) out.push(`  ${show(l)}`);
  };
  section(r.dryRun ? "Would file:" : "Filed:", r.filed, (l) => `${l.label}: ${l.title}${l.id ? `  [${l.id}]` : ""}`);
  section("Deferred:", r.deferred, (l) => `${l.label}: ${l.reason}`);
  section("Skipped:", r.skipped, (l) => `${l.label}${l.title ? ` (${l.title.slice(0, 60)}${l.title.length > 60 ? "…" : ""})` : ""}: ${l.reason}`);
  if (r.briefing) out.push("", `Briefing: ${r.briefing}`);
  if (!r.filed.length && !r.deferred.length) out.push("", "Nothing new.");
  return out.join("\n");
}
