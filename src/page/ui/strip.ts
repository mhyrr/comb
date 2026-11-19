/**
 * The figure strip under Now's headline (docs/design/2026-11-17-now-dashboard.md
 * §4.1): four numbers, each with one line of context, from data the page
 * already has. Working now and Waiting on you come from the snapshot, Ready to
 * merge from /api/pulls, Session limit from /api/usage's limits. A source that
 * is missing or broken says so in its own figure. Pure: no DOM, so tests run it.
 */
import type { PullsReport } from "../../github";
import type { Limits } from "../../limits";
import type { QueueItem } from "../../queue";
import type { AgentNode, SessionNode } from "../state";
import { esc } from "./md";

/** Where the PR figure stands: off without hive, loading before the first read. */
export type PullsState =
  | { state: "off" }
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ok"; report: PullsReport };

/** A figure: its label, the number (with an optional small unit), and its one line of context. */
export type Figure = {
  key: "working" | "waiting" | "merge" | "limit";
  label: string;
  value: string;
  unit?: string;
  context: string;
  /** Grey number: the source is missing, stale or still loading. */
  muted?: boolean;
  /** Only Working now: the honey hex is filled while something works. */
  live?: boolean;
  /** Where a click goes: an agent's page, or a block on Now to scroll to. */
  href?: string;
  jump?: "queue" | "usage";
};

export type StripInput = {
  agents: Pick<AgentNode, "name" | "activity" | "finished">[];
  mine: Pick<SessionNode, "activity">[];
  queue: Pick<QueueItem, "status" | "created" | "from">[];
  pulls: PullsState;
  /** Undefined until /api/usage answers. */
  limits: Limits | undefined;
  now: number;
  /** How the page names someone ("greg" is the human, "maya" is Maya). */
  who?: (name: string) => string;
};

/** "37m", "3h", "2d": the age of a thing. */
export function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** "2h 20m", "45m", "1d 3h": time until something happens. */
export function until(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function stripFigures(i: StripInput): Figure[] {
  const who = i.who ?? ((n: string) => n);
  const figures: Figure[] = [];

  // Working now: comb agents on a turn, out of the agents still in the tree.
  const inTree = i.agents.filter((a) => !a.finished);
  const working = inTree.filter((a) => a.activity === "working");
  const yours = i.mine.filter((s) => s.activity === "working").length;
  const names = working.length === 0 ? "" : working.length === 1 ? working[0]!.name : `${working[0]!.name} and ${working.length - 1} more`;
  figures.push({
    key: "working",
    label: "Working now",
    value: String(working.length),
    unit: `of ${plural(inTree.length, "agent")}`,
    context: [names || "No agent is on a turn", yours ? `${yours} of your sessions too` : ""].filter(Boolean).join(" · "),
    live: working.length > 0,
    ...(working.length === 1 ? { href: `#/agent/${encodeURIComponent(working[0]!.name)}` } : {}),
  });

  // Waiting on you: open queue items, and how long the oldest has waited.
  const open = i.queue.filter((q) => q.status === "open");
  const oldest = open.reduce<(typeof open)[number] | null>((o, q) => (!o || Date.parse(q.created) < Date.parse(o.created) ? q : o), null);
  figures.push({
    key: "waiting",
    label: "Waiting on you",
    value: String(open.length),
    context: oldest ? `Oldest ${span(i.now - Date.parse(oldest.created))}, from ${who(oldest.from)}` : "Nothing waits on you",
    jump: "queue",
  });

  // Ready to merge: PRs a person could merge now. Without hive there are no PRs, so no figure.
  if (i.pulls.state === "loading") {
    figures.push({ key: "merge", label: "Ready to merge", value: "…", context: "Reading pull requests", muted: true });
  } else if (i.pulls.state === "error") {
    figures.push({ key: "merge", label: "Ready to merge", value: "—", context: `Couldn't read pull requests: ${i.pulls.message}`, muted: true });
  } else if (i.pulls.state === "ok") {
    const r = i.pulls.report;
    if (r.problem && !r.pulls.length) {
      figures.push({ key: "merge", label: "Ready to merge", value: "—", context: r.problem, muted: true });
    } else if (!r.repos && !r.pulls.length) {
      // Nothing was read, so "none open" would be a claim nobody checked.
      const why = !r.at ? "Reading pull requests" : r.skipped.length ? "No project is on GitHub" : "No projects to read";
      figures.push({ key: "merge", label: "Ready to merge", value: r.at ? "—" : "…", context: why, muted: true });
    } else {
      const by = (s: string[]) => r.pulls.filter((p) => s.includes(p.readiness)).length;
      const ready = by(["ready"]);
      const rest = [
        by(["running"]) ? `${by(["running"])} with CI running` : "",
        by(["failing", "conflicts"]) ? `${by(["failing", "conflicts"])} failing or in conflict` : "",
        by(["review", "unknown"]) ? `${by(["review", "unknown"])} waiting on review or GitHub` : "",
      ].filter(Boolean);
      figures.push({
        key: "merge",
        label: "Ready to merge",
        value: String(ready),
        unit: `of ${plural(r.pulls.length, "PR")}`,
        context: !r.pulls.length ? "No open pull requests" : rest.length ? rest.join(", ") : ready === r.pulls.length ? "All of them" : "",
      });
    }
  }

  // Session limit: the five-hour window, when it resets, and the week beside it.
  const l = i.limits;
  if (!l) {
    figures.push({ key: "limit", label: "Session limit", value: "…", context: "Reading limits", muted: true, jump: "usage" });
  } else if (l.status !== "ok") {
    figures.push({ key: "limit", label: "Session limit", value: "—", context: l.message, muted: true, jump: "usage" });
  } else {
    const s = l.windows.find((w) => w.id === "five_hour");
    const week = l.windows.find((w) => w.id === "seven_day");
    const weekLine = week?.usedPercent != null ? `week ${Math.round(week.usedPercent)}%` : "";
    const asOf = l.stale ? `as of ${span(i.now - Date.parse(l.asOf))} ago` : "";
    if (!s) {
      figures.push({ key: "limit", label: "Session limit", value: "—", context: ["No session window in the reading", weekLine].filter(Boolean).join(" · "), muted: true, jump: "usage" });
    } else if (s.usedPercent == null) {
      figures.push({ key: "limit", label: "Session limit", value: "—", context: ["Reset since the last reading", weekLine].filter(Boolean).join(" · "), muted: true, jump: "usage" });
    } else {
      const resets = s.resetsAt ? `Resets in ${until(Date.parse(s.resetsAt) - i.now)}` : "";
      figures.push({
        key: "limit",
        label: "Session limit",
        value: `${Math.round(s.usedPercent)}%`,
        unit: "used",
        context: [resets, weekLine, asOf].filter(Boolean).join(" · "),
        muted: l.stale,
        jump: "usage",
      });
    }
  }
  return figures;
}

const HEX = "M11 1.5 20.5 7v10L11 22.5 1.5 17V7z";

export function stripHtml(figures: Figure[]): string {
  return `<div class="strip n${figures.length}" role="list">${figures.map((f) => {
    const hex = f.key === "working" ? `<svg class="strip-hex${f.live ? " live" : ""}" viewBox="0 0 22 24" aria-hidden="true"><path d="${HEX}"/></svg>` : "";
    const inner = `<span class="sk">${hex}${esc(f.label)}</span>
      <span class="sv${f.muted ? " muted" : ""}">${esc(f.value)}${f.unit ? ` <small>${esc(f.unit)}</small>` : ""}</span>
      <span class="sc">${esc(f.context)}</span>`;
    const label = esc(`${f.label}: ${f.value}${f.unit ? ` ${f.unit}` : ""}. ${f.context}`);
    if (f.href) return `<a class="fig" role="listitem" href="${esc(f.href)}" aria-label="${label}">${inner}</a>`;
    if (f.jump) return `<button type="button" class="fig" role="listitem" data-jump="${f.jump}" aria-label="${label}">${inner}</button>`;
    return `<div class="fig" role="listitem" aria-label="${label}">${inner}</div>`;
  }).join("")}</div>`;
}
