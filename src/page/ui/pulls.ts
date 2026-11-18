/**
 * Open pull requests in the top bar, on every view (Greg, 2026-11-17). Links
 * only; review happens on GitHub.
 *
 * Wide: compact badges between the view tabs and Find, colored by merge
 * readiness, each with a hover card. Badges that do not fit collapse into
 * "+N", which opens a list of the rest. Phone: one "PRs N" pill that opens
 * the whole list, because a touch screen has no hover to show a badge's title,
 * and a second header row would take space from every view.
 */
import type { BotGroup, Pull, PullsReport, Readiness } from "../../github";
import { registerCard } from "./card";
import { fitCount } from "./fit";
import { esc } from "./md";
import { setHtml } from "./patch";

const HEX = "M11 1.5 20.5 7v10L11 22.5 1.5 17V7z";
const GAP = 6;

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  const a = s < 45 ? "now" : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  return a === "now" ? "just now" : `${a} ago`;
}
/** app.ts's timer keeps every <time data-ago> fresh. */
const agoTag = (iso: string) => `<time data-ago="${esc(iso)}" data-long="1" title="${esc(new Date(iso).toLocaleString())}">${ago(iso)}</time>`;

// ---------------------------------------------------------------- what the colors say

/** A badge's color is merge readiness; both reds read red, both greys grey. */
const TONE: Record<Readiness, "ok" | "bad" | "wait" | "idle"> = {
  ready: "ok", failing: "bad", conflicts: "bad", running: "wait", review: "idle", unknown: "idle",
};
const RANK = { bad: 3, wait: 2, idle: 1, ok: 0 } as const;
const LEGEND: [Readiness, string][] = [
  ["ready", "Ready to merge: CI passed (or the repo has none), no conflicts, no review holding it. Drafts can be green."],
  ["failing", "CI failing, or the branch has merge conflicts."],
  ["running", "CI is still running."],
  ["unknown", "Waiting on a required review, or GitHub is still working out whether it can merge."],
];

function mark(r: Readiness): string {
  return `<svg class="pr-ci tone-${TONE[r]}" viewBox="0 0 22 24" aria-hidden="true"><path d="${HEX}"/></svg>`;
}

/** The most urgent of several: one red among them makes the group red. */
function worst(rs: Readiness[]): Readiness {
  if (!rs.length) return "unknown";
  if (rs.every((r) => r === "ready")) return "ready";
  return rs.reduce((a, b) => (RANK[TONE[b]] > RANK[TONE[a]] ? b : a));
}

const checkList = (names: string[]) => esc([...new Set(names)].join(", "));

/** Why the badge has its color, in words. */
function statusLine(p: Pull): string {
  const conflicts = p.mergeable === "CONFLICTING" || p.mergeState === "DIRTY";
  switch (p.readiness) {
    case "ready": return p.ci === "none" ? "<b>Ready to merge</b> · No CI on this repo" : `<b>Ready to merge</b> · CI passed ${p.ciDone ? agoTag(p.ciDone) : ""}`;
    case "failing": return `<b>CI failing:</b> ${checkList(p.failing)}${conflicts ? " · Merge conflicts" : ""}`;
    case "conflicts": return `<b>Merge conflicts</b>${p.ci === "none" ? " · No CI on this repo" : p.ci === "passing" ? " · CI passed" : ""}`;
    case "running": return `<b>CI running:</b> ${checkList(p.running)}`;
    case "review": return p.review === "CHANGES_REQUESTED" ? "<b>Changes requested</b>" : "<b>Waiting on a required review</b>";
    case "unknown": return "<b>Checking</b> · GitHub is still working out whether it can merge";
  }
}

// ---------------------------------------------------------------- badges and cards

/** A badge's hover card, kept inside it so the shared card can copy it. */
function pullTip(p: Pull): string {
  return `<span class="tip-src" hidden><span class="tip-title">${esc(p.title)}</span>
    <span class="tip-line tone-${TONE[p.readiness]}">${mark(p.readiness)}<span>${statusLine(p)}</span></span>
    <span class="tip-line"><span>${esc(p.project)} #${p.number} · ${p.draft ? "Draft" : "Ready for review"} · <code>${esc(p.head)}</code></span></span>
    <span class="tip-line tip-faint"><span>Opened ${agoTag(p.created)} · updated ${agoTag(p.updated)}${p.agent ? "" : ` · by ${esc(p.author)}`}</span></span></span>`;
}

const plain = (html: string) => html.replace(/<[^>]+>/g, "");

function pullBadge(p: Pull): string {
  const label = `${p.project} #${p.number}: ${p.title}. ${plain(statusLine(p))}${p.draft ? " Draft." : ""}`;
  return `<a class="prb tone-${TONE[p.readiness]}" data-tone="${TONE[p.readiness]}" href="${esc(p.url)}" target="_blank" rel="noreferrer" aria-label="${esc(label)}">${mark(p.readiness)}<span>${esc(p.project)}</span><span class="mono">#${p.number}</span>${pullTip(p)}</a>`;
}

const botsUrl = (g: BotGroup) => `https://github.com/${g.repo}/pulls?q=${encodeURIComponent(`is:pr is:open author:app/${g.pulls[0]!.author}`)}`;

/** Bot PRs in one repo (only with pullsShowBots), as one badge. */
function botBadge(g: BotGroup): string {
  const r = worst(g.pulls.map((p) => p.readiness));
  const n = g.pulls.length;
  const tip = `<span class="tip-src" hidden><span class="tip-title">${n} dependency ${n === 1 ? "update" : "updates"} from ${esc(g.pulls[0]!.author)}</span>${g.pulls.map((p) =>
    `<span class="tip-line">${mark(p.readiness)}<span>#${p.number} ${esc(p.title)}</span></span>`).join("")}</span>`;
  return `<a class="prb bots tone-${TONE[r]}" data-tone="${TONE[r]}" href="${esc(botsUrl(g))}" target="_blank" rel="noreferrer" aria-label="${esc(`${g.project}: ${n} dependency updates`)}">${mark(r)}<span>${esc(g.project)}</span><span class="deps">· ${n} deps</span>${tip}</a>`;
}

/** Where the PRs came from, and anything that went wrong: one quiet line each. */
function notes(r: PullsReport): string[] {
  const repos = `${r.repos} ${r.repos === 1 ? "repo" : "repos"}`;
  const n = r.pulls.length + r.bots.length;
  return [
    r.problem ?? "",
    r.problem ? "" : `${n ? "From" : "No open pull requests in"} ${repos}${r.at ? `, checked ${ago(r.at)}` : ""}.`,
    r.failed.length && !r.problem ? `Couldn't read ${r.failed.map((f) => f.repo).join(", ")}: ${r.failed[0]!.error}` : "",
    r.skipped.length ? `Not on GitHub: ${r.skipped.map((s) => s.project).join(", ")}.` : "",
  ].filter(Boolean);
}

function legendLines(): string {
  return LEGEND.map(([r, text]) => `<span class="tip-line">${mark(r)}<span>${esc(text)}</span></span>`).join("");
}

/** The "?": what each color means, then where the PRs came from. */
function legendButton(r: PullsReport): string {
  return `<button type="button" class="pr-help" aria-label="What the colors mean">?<span class="tip-src" hidden><span class="tip-title">Badge colors</span>${legendLines()}${notes(r).map((n) =>
    `<span class="tip-line tip-faint">${esc(n)}</span>`).join("")}</span></button>`;
}

// ---------------------------------------------------------------- the bar

let data: PullsReport | null = null;
let fetchedAt = 0;
let busy = false;

/** Fetches /api/pulls at most once a minute (every few seconds while the server refreshes) and redraws. */
export async function refreshPulls(hiveOn: boolean): Promise<void> {
  const el = document.getElementById("bar-prs");
  if (!el) return;
  if (!hiveOn) { setHtml(el, ""); return; }
  const wait = data?.refreshing ? 4_000 : 60_000;
  if ((!data || Date.now() - fetchedAt > wait) && !busy) {
    busy = true;
    fetchedAt = Date.now();
    try {
      data = await fetch("/api/pulls").then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
        return body as PullsReport;
      });
    } catch (err) {
      setHtml(el, `<span class="bp-label">PRs</span><span class="bp-note" tabindex="0">unavailable<span class="tip-src" hidden><span class="tip-title">Couldn't read pull requests</span><span class="tip-line">${esc((err as Error).message)}</span></span></span>`);
      return;
    } finally {
      busy = false;
    }
  }
  if (!data) return;
  const before = el.dataset.html;
  setHtml(el, barHtml(data));
  if (el.dataset.html !== before) fit(); // state ticks every few seconds; refit only on a change
}

function barHtml(r: PullsReport): string {
  const n = r.pulls.length;
  const all = [...r.pulls.map((p) => p.readiness), ...r.bots.flatMap((g) => g.pulls.map((p) => p.readiness))];
  if (!n && !r.bots.length) {
    const why = notes(r);
    return `<span class="bp-label">PRs</span><span class="bp-note" tabindex="0">${r.problem ? "unavailable" : "none open"}<span class="tip-src" hidden><span class="tip-title">Pull requests</span>${why.map((t) =>
      `<span class="tip-line">${esc(t)}</span>`).join("")}</span></span>`;
  }
  return `<span class="bp-label">PRs <b>${n}</b></span>${legendButton(r)}
    <span class="bp-badges">${r.pulls.map(pullBadge).join("")}${r.bots.map(botBadge).join("")}</span>
    <button type="button" class="bp-more" aria-haspopup="dialog" hidden></button>
    <button type="button" class="bp-pill" aria-haspopup="dialog">${mark(worst(all))}PRs <b>${n}</b></button>`;
}

/** Shows as many badges as fit and folds the rest into "+N", colored by the worst it hides. */
function fit(): void {
  const el = document.getElementById("bar-prs");
  const box = el?.querySelector<HTMLElement>(".bp-badges");
  const more = el?.querySelector<HTMLElement>(".bp-more");
  if (!el || !box || !more || box.offsetParent === null) return; // phone: the pill stands in
  const badges = [...box.children] as HTMLElement[];
  for (const b of badges) b.hidden = false;
  more.hidden = false;
  more.innerHTML = `${mark("unknown")}+${badges.length}`;
  const moreW = more.offsetWidth;
  more.hidden = true;
  const fixed = [...el.children].filter((c) => c !== box && c !== more && (c as HTMLElement).offsetParent !== null) as HTMLElement[];
  const avail = el.clientWidth - fixed.reduce((s, c) => s + c.offsetWidth + GAP, 0);
  const shown = fitCount(badges.map((b) => b.offsetWidth), avail, moreW + GAP, GAP);
  badges.forEach((b, i) => { b.hidden = i >= shown; });
  const rest = badges.slice(shown);
  if (rest.length) {
    const tones = rest.map((b) => b.dataset.tone ?? "idle");
    const r: Readiness = tones.includes("bad") ? "failing" : tones.includes("wait") ? "running" : tones.every((t) => t === "ok") ? "ready" : "unknown";
    more.innerHTML = `${mark(r)}+${rest.length}`;
    more.setAttribute("aria-label", `${rest.length} more pull requests`);
    more.hidden = false;
  }
  hiddenFrom = shown;
}
let hiddenFrom = Infinity;

// ---------------------------------------------------------------- the list (from "+N" or the pill)

function listRow(p: Pull): string {
  return `<a class="pp-row" href="${esc(p.url)}" target="_blank" rel="noreferrer">${mark(p.readiness)}<span class="pp-main"><span class="pp-title"><b>${esc(p.project)} #${p.number}</b> ${esc(p.title)}</span><span class="pp-status">${statusLine(p)}${p.draft ? " · Draft" : ""}</span></span></a>`;
}
function listBotRow(g: BotGroup): string {
  const n = g.pulls.length;
  return `<a class="pp-row" href="${esc(botsUrl(g))}" target="_blank" rel="noreferrer">${mark(worst(g.pulls.map((p) => p.readiness)))}<span class="pp-main"><span class="pp-title"><b>${esc(g.project)}</b> ${n} dependency ${n === 1 ? "update" : "updates"}</span><span class="pp-status">from ${esc(g.pulls[0]!.author)}</span></span></a>`;
}

let popEl: HTMLElement | null = null;
let popFor: HTMLElement | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

function openList(from: HTMLElement, onlyHidden: boolean): void {
  if (!data) return;
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  const pulls = onlyHidden ? data.pulls.slice(hiddenFrom) : data.pulls;
  const bots = onlyHidden ? data.bots.slice(Math.max(0, hiddenFrom - data.pulls.length)) : data.bots;
  if (!popEl) {
    popEl = document.createElement("div");
    popEl.className = "pr-pop";
    popEl.setAttribute("role", "dialog");
    popEl.setAttribute("aria-label", "Pull requests");
    popEl.addEventListener("mouseenter", () => { if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; } });
    popEl.addEventListener("mouseleave", () => { if (!pinned) closeSoon(); });
    document.body.append(popEl);
  }
  popEl.innerHTML = `<div class="pp-head">${onlyHidden ? `${pulls.length + bots.length} more` : "Pull requests"} <span>${data.pulls.length} open</span></div>
    <div class="pp-list">${pulls.map(listRow).join("")}${bots.map(listBotRow).join("")}</div>
    <div class="pp-foot">${onlyHidden ? "" : `<div class="pp-legend">${legendLines()}</div>`}${notes(data).map((n) => `<p>${esc(n)}</p>`).join("")}</div>`;
  popEl.style.left = "0px";
  popEl.style.top = "0px";
  popEl.hidden = false;
  popFor = from;
  from.setAttribute("aria-expanded", "true");
  const at = from.getBoundingClientRect();
  const w = popEl.offsetWidth;
  popEl.style.left = `${Math.max(8, Math.min(at.right - w, innerWidth - w - 8))}px`;
  popEl.style.top = `${at.bottom + 6}px`;
  popEl.style.maxHeight = `${Math.max(160, innerHeight - at.bottom - 18)}px`;
}

function closeList(): void {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  if (popEl) popEl.hidden = true;
  pinned = false;
  popFor?.setAttribute("aria-expanded", "false");
  popFor = null;
}
function closeSoon(): void {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(closeList, 250);
}

const listHost = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>(".bp-more, .bp-pill") : null);
/** A click pins the list open; hover alone opens it until the pointer leaves. */
let pinned = false;
document.addEventListener("click", (e) => {
  const h = listHost(e.target);
  if (h) {
    const open = popFor === h && !popEl?.hidden;
    if (open && pinned) { closeList(); return; }
    if (!open) openList(h, h.classList.contains("bp-more"));
    pinned = true; // a click on a list hover already opened keeps it, rather than shutting it
    return;
  }
  if (popEl && !popEl.hidden && !popEl.contains(e.target as Node)) closeList();
});
document.addEventListener("mouseover", (e) => {
  const h = listHost(e.target);
  if (h?.classList.contains("bp-more") && (popFor !== h || popEl?.hidden)) { pinned = false; openList(h, true); }
});
document.addEventListener("mouseout", (e) => {
  const h = listHost(e.target);
  if (!pinned && h && !h.contains(e.relatedTarget as Node | null) && !popEl?.contains(e.relatedTarget as Node | null)) closeSoon();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && popEl && !popEl.hidden) { closeList(); popFor?.focus(); } });

// ---------------------------------------------------------------- the hover card (card.ts draws it)

registerCard({ selector: ".prb, .pr-help, .bp-note", render: (el) => el.querySelector(":scope > .tip-src")?.innerHTML ?? null });
// The bar sits above the panes, so only the page itself scrolling (a phone) moves it.
document.addEventListener("scroll", (e) => { if (e.target === document) closeList(); }, true);

// The bar's width changes with the window, not with the panes: refit on resize.
let fitFrame = 0;
addEventListener("resize", () => {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => { fit(); closeList(); });
});
