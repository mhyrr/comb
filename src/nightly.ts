/**
 * hive's nightly asks, filed into comb's queue (design §9.3, D22).
 *
 * hive writes two things Greg should act on: the Act watches' picks in
 * ~/.hive/next.json (one ticket per project) and the briefing's "What needs
 * your attention" list. comb reads both, read-only, and files each new one as
 * a queue item from Maya: a pick as a proposal to start a task agent, an ask as
 * a decision. hive never learns that comb exists.
 *
 * Asks are off unless config.json sets `nightlyAsks: true` (2026-11-15): they
 * come from Greg's own sessions, and he did not want those decisions here.
 *
 * Each run first sweeps the queue (TK-008, D30): an open card whose ticket is
 * closed, taken (in_progress), already declined by Greg, or worked on a
 * branch since the card is withdrawn with a reason. Withdrawn is not an answer.
 *
 * Every run is safe to repeat. ~/.comb/nightly/filed.json records each item
 * filed, keyed by project+ticket+selectedAt for a pick and date+text for an
 * ask, so nothing is filed twice.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readCombConfig } from "./config";
import { hiveProjectPaths, listHiveProjects, parseAttention, readActPicks, readBriefing, readTicketFile, resolveHiveHome, type ActPick, type TicketFile } from "./hive";
import { getCombPaths, resolveCombHome } from "./paths";
import { addItem, listItems, withdrawItem, type QueueItem } from "./queue";

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
  /** File the briefing's asks too. Defaults to config.json's `nightlyAsks` (false). */
  asks?: boolean;
  /** A repo's branches, for the sweep. Defaults to a local, read-only git read (gitBranches). */
  branches?: BranchReader;
};

/** A branch and the committer time of its tip. */
export type Branch = { name: string; at: string };
export type BranchReader = (repo: string) => Branch[];

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
  /** Open cards the sweep took away (or, in a dry run, would), with the reason. */
  withdrawn: NightlyLine[];
  filed: NightlyLine[];
  deferred: NightlyLine[];
  skipped: NightlyLine[];
  /** Why there is nothing from the briefing, when there is no briefing. */
  briefing: string | null;
  /** Whether briefing asks were read at all (config.json `nightlyAsks`). */
  asks: boolean;
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

const pickAction = (project: string, ticket: string) => `Maya starts task agent ${agentNameFor(project, ticket)} on ${project} ${ticket}.`;

/**
 * A card whose go starts a task agent on a ticket: hive's pick, or Maya's own
 * card of the same shape. The sweep's in_progress, branch and Not now rules
 * apply only to these.
 */
export function isPick(i: Pick<QueueItem, "kind" | "from" | "project" | "ticket" | "action">): boolean {
  return i.kind === "proposal" && i.from === NIGHTLY_FROM && !!i.project && !!i.ticket && i.action === pickAction(i.project, i.ticket);
}

const later = (a: string | null, b: string | null) => !!a && !!b && Date.parse(a) > Date.parse(b);
const sameTicket = (a: Pick<QueueItem, "project" | "ticket">, b: Pick<QueueItem, "project" | "ticket">) =>
  a.project === b.project && !!a.ticket && a.ticket.toUpperCase() === b.ticket?.toUpperCase();

/**
 * Greg's Not now on a pick of the same ticket that still holds: answered before
 * `before`, and the ticket not updated since (TK-008). A ticket with no
 * `updated` time has not changed, so the Not now holds.
 */
function standingNo(declined: QueueItem[], project: string, ticket: string, t: TicketFile, before: string | null): QueueItem | null {
  return declined.find((d) =>
    sameTicket(d, { project, ticket }) && !!d.answered && (!before || Date.parse(d.answered) < Date.parse(before)) && !later(t.updated, d.answered),
  ) ?? null;
}

const noLine = (d: QueueItem) => `Greg said Not now on ${(d.answered ?? "").slice(0, 10)} (${d.id}), and the ticket has not changed since`;

/** A branch names the ticket: `tk-002`, `TK002`, `worktree-contentdash-tk-002`, not `tk-0021`. */
export function branchNames(branch: string, ticket: string): boolean {
  const m = ticket.match(/^([A-Za-z]+)-?(\d+)$/);
  if (!m) return false;
  return new RegExp(`(^|[^a-z0-9])${m[1]!.toLowerCase()}-?${m[2]}(?!\\d)`).test(branch.toLowerCase());
}

/**
 * A repo's local branches and remote-tracking refs with their tip times. Local
 * and read-only: no fetch, no prompt (GIT_TERMINAL_PROMPT=0), no lock taken
 * (GIT_OPTIONAL_LOCKS=0), and a 5 s limit. Not a repo, or any git failure,
 * reads as no branches.
 */
export function gitBranches(repo: string): Branch[] {
  if (!existsSync(join(repo, ".git"))) return [];
  let out: string;
  try {
    out = execFileSync("git", ["-C", repo, "for-each-ref", "--format=%(refname:short)\t%(committerdate:iso-strict)", "refs/heads", "refs/remotes"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
  } catch {
    return []; // intentional: an unreadable repo gives the branch rule nothing to go on
  }
  return out.split("\n").map((l) => l.split("\t")).filter((p) => p.length === 2 && p[0] && p[1]).map(([name, at]) => ({ name: name!, at: at! }));
}

/**
 * Why an open card should leave the queue, or null to keep it (TK-008):
 *   1. its ticket is closed or done: any card, if the ticket changed after the
 *      card was filed (a pick, always), so a review filed after a close stays;
 *   2. a pick whose ticket is in_progress: someone took the work;
 *   3. a pick Greg already said Not now to, ticket unchanged since;
 *   4. a pick whose ticket a branch names, with commits newer than the card.
 */
export function withdrawReason(
  item: QueueItem, t: TicketFile, declined: QueueItem[], branches: () => Branch[],
): string | null {
  const pick = isPick(item);
  if (CLOSED.has(t.status) && (pick || later(t.updated, item.created))) return `${item.ticket} is ${t.status}`;
  if (!pick) return null;
  if (t.status === "in_progress") return `${item.ticket} is in_progress: someone has the work`;
  const no = standingNo(declined, item.project!, item.ticket!, t, item.created);
  if (no) return noLine(no);
  const b = branches().filter((x) => branchNames(x.name, item.ticket!) && later(x.at, item.created)).sort((x, y) => Date.parse(y.at) - Date.parse(x.at))[0];
  if (b) return `branch ${b.name} has commits since the card (${b.at.slice(0, 10)})`;
  return null;
}

/** The open cards the sweep takes away. Writes nothing; runNightly applies it. */
function planSweep(all: QueueItem[], hiveHome: string, readBranches: BranchReader): { item: QueueItem; reason: string }[] {
  const declined = all.filter((i) => i.status === "declined" && isPick(i));
  const repos = new Map(hiveProjectPaths(hiveHome).map((p) => [p.name, p.path]));
  const cache = new Map<string, Branch[]>();
  const branchesOf = (project: string) => () => {
    const repo = repos.get(project);
    if (!repo) return [];
    if (!cache.has(repo)) cache.set(repo, readBranches(repo));
    return cache.get(repo)!;
  };
  const out: { item: QueueItem; reason: string }[] = [];
  for (const item of all) {
    if (item.status !== "open" || !item.project || !item.ticket) continue;
    const t = readTicketFile(item.project, item.ticket, hiveHome);
    if (!t) continue;
    const reason = withdrawReason(item, t, declined, branchesOf(item.project));
    if (reason) out.push({ item, reason });
  }
  return out;
}

function planPick(p: ActPick, ticket: TicketFile): Omit<Planned, "key" | "label"> {
  const agent = agentNameFor(p.project, p.ticket);
  const meta = [ticket.status, ticket.priority ? `P${ticket.priority}` : null, ticket.type].filter(Boolean).join(", ");
  return {
    kind: "proposal",
    project: p.project,
    ticket: p.ticket,
    title: `Start ${p.project} ${p.ticket}: ${ticket.title || "(untitled)"}`,
    action: pickAction(p.project, p.ticket),
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
  const asksOn = opts.asks ?? readCombConfig(home).nightlyAsks;
  const today = localDate(now);
  const path = stateFile(home);
  const state = await loadState(path);
  for (const [k, r] of Object.entries(state.filed)) {
    if (now.getTime() - Date.parse(r.at) > KEEP_RECORD_DAYS * DAY_MS) delete state.filed[k];
  }
  const report: NightlyReport = { date: today, dryRun, withdrawn: [], filed: [], deferred: [], skipped: [], briefing: null, asks: asksOn };
  // Every item, so a Not now from any day still counts.
  const all = await listItems(home, Infinity, now.getTime());
  const declined = all.filter((i) => i.status === "declined" && isPick(i));

  // The sweep first: open cards whose work is done or taken leave, without an answer (TK-008).
  const gone = new Set<string>();
  for (const { item, reason } of planSweep(all, hiveHome, opts.branches ?? gitBranches)) {
    const label = `${item.project} ${item.ticket}`;
    if (!dryRun) {
      try {
        await withdrawItem(item.id, reason, "sweep", home, now);
      } catch (err) {
        report.skipped.push({ label, title: item.title, reason: `could not withdraw ${item.id}: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
    }
    gone.add(item.id);
    report.withdrawn.push({ label, title: item.title, reason, id: item.id });
  }
  const open = all.filter((i) => i.status === "open" && !gone.has(i.id));
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
    let no: QueueItem | null;
    if (earlier) reason = `already filed ${earlier.date} (${earlier.id})`;
    else if (days > STALE_PICK_DAYS) reason = `stale: picked ${p.selectedAt.slice(0, 10)}, ${days} days ago`;
    else if (!ticket) reason = `hive has no ticket ${p.project}/${p.ticket}`;
    else if (CLOSED.has(ticket.status)) reason = `ticket is ${ticket.status}`;
    // The sweep would withdraw it within the hour; do not file it at all.
    else if (ticket.status === "in_progress") reason = "ticket is in_progress: someone has the work";
    else if ((no = standingNo(declined, p.project, p.ticket, ticket, null))) reason = noLine(no);
    else if (dup) reason = `already open in the queue: ${dup.id}`;
    else if (filedTonight.some((r) => r.kind === "pick" && r.project === p.project)) reason = "one pick per project a night; this project's is filed";
    if (ticket && !CLOSED.has(ticket.status) && days <= STALE_PICK_DAYS) current.push({ project: p.project, ticket: p.ticket, label });
    if (reason) report.skipped.push({ label, reason });
    else picks.push({ key, label, ...planPick(p, ticket!) });
  }

  // Asks: today's briefing only, and only when config.json turns them on.
  // Yesterday's asks are yesterday's.
  const asks: Planned[] = [];
  const briefing = asksOn ? readBriefing(today, hiveHome) : null;
  if (asksOn && briefing === null) report.briefing = `no briefing for ${today} yet`;
  const projects = asksOn ? listHiveProjects(hiveHome) : [];
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
  section(r.dryRun ? "Would withdraw:" : "Withdrew:", r.withdrawn, (l) => `${l.label}: ${l.reason}  [${l.id}]`);
  section(r.dryRun ? "Would file:" : "Filed:", r.filed, (l) => `${l.label}: ${l.title}${l.id ? `  [${l.id}]` : ""}`);
  section("Deferred:", r.deferred, (l) => `${l.label}: ${l.reason}`);
  section("Skipped:", r.skipped, (l) => `${l.label}${l.title ? ` (${l.title.slice(0, 60)}${l.title.length > 60 ? "…" : ""})` : ""}: ${l.reason}`);
  if (!r.asks) out.push("", "asks: off (set nightlyAsks in config.json)");
  else if (r.briefing) out.push("", `Briefing: ${r.briefing}`);
  if (!r.filed.length && !r.deferred.length && !r.withdrawn.length) out.push("", "Nothing new.");
  return out.join("\n");
}
