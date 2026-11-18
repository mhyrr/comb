/**
 * The usage panel on the Now tab: Claude Code's tokens today and this week,
 * 30 days of output as columns, the split by model family, and how the other
 * harnesses on this machine compare. Every number comes from /api/usage
 * (src/usage.ts); this file only lays them out.
 */
import type { Limits, LimitWindow } from "../../limits";
import type { HarnessRow, Totals, UsageSummary } from "../../usage";
import { esc } from "./md";

export type UsagePayload =
  | (UsageSummary & { limits?: Limits; error: string | null })
  | { ready: false; limits?: Limits; error: string | null };

/** "7:40pm" today, "Nov 22 at 2:00pm" another day: the way /usage says it. */
export function resetTime(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\s?([AP])M$/i, (_, p: string) => `${p.toLowerCase()}m`);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? time : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} at ${time}`;
}

/** The plan-limit bars, as Claude Code's /usage shows them. */
export function limitsHtml(l: Limits | undefined, now = Date.now()): string {
  if (!l) return "";
  if (l.status !== "ok") return `<div class="u-limits"><p class="quiet u-limits-none">${esc(l.message)}</p></div>`;
  const bar = (w: LimitWindow) => {
    const pct = w.usedPercent ?? 0;
    const level = pct >= 90 ? " high" : pct >= 75 ? " warn" : "";
    const right = w.reset ? "reset" : `${Math.round(pct)}% used`;
    const under = w.reset
      ? `Reset ${w.resetsAt ? resetTime(w.resetsAt, now) : ""}. A new reading comes with the next Claude reply.`
      : w.resetsAt ? `Resets ${resetTime(w.resetsAt, now)}` : "";
    return `<div class="u-limit${level}${w.reset ? " is-reset" : ""}">
      <div class="u-lhead"><b>${esc(w.label)}</b><span>${right}</span></div>
      <div class="u-meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="${esc(w.label)}"><span style="width:${pct}%"></span></div>
      <div class="u-lsub">${esc(under)}</div></div>`;
  };
  const asOf = `As of ${resetTime(l.asOf, now)}${l.stale ? ". It updates when a Claude session replies" : ""}.`;
  return `<div class="u-limits">${l.windows.map(bar).join("")}
    <p class="u-lnote">Fable weekly: only in <code>/usage</code></p>
    <p class="u-lnote${l.stale ? " stale" : ""}">${esc(asOf)}</p>
    ${l.warning ? `<p class="u-lnote stale u-lwarn">${esc(l.warning)}</p>` : ""}</div>`;
}

/** 1,284 / 12.9K / 4.72B: compact past 10,000. */
export function compact(v: number): string {
  if (v < 10_000) return Math.round(v).toLocaleString("en-US");
  for (const [div, unit] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (v >= div) {
      const x = v / div;
      return `${x >= 100 ? Math.round(x) : x.toFixed(x >= 10 ? 1 : 2).replace(/\.?0+$/, "")}${unit}`;
    }
  }
  return String(v);
}

export function dollars(v: number): string {
  return v >= 100 ? `$${Math.round(v).toLocaleString("en-US")}` : `$${v.toFixed(2)}`;
}

/** "claude-opus-5-5" → "Opus 5.5". */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(id);
  if (!m) return id;
  return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/** Families keep their color whatever their rank: color follows the entity. */
const FAMILIES = ["opus", "fable", "sonnet"] as const;
export function familyOf(id: string): string {
  return FAMILIES.find((f) => id.includes(`-${f}-`) || id.startsWith(`claude-${f}`)) ?? "other";
}

const day = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function usageHtml(u: UsagePayload, now = Date.now()): string {
  const head = `<h2>Usage</h2>${limitsHtml(u.limits, now)}`;
  if (!("claude" in u)) {
    return `${head}<p class="quiet">${u.error ? `Could not read usage: ${esc(u.error)}` : "Reading transcripts…"}</p>`;
  }
  const c = u.claude;
  const claudeRow = u.harnesses.find((h) => h.id === "claude");
  if (claudeRow?.status === "missing") {
    return `${head}<p class="quiet">Claude Code keeps no transcripts on this machine yet.</p>${harnessHtml(u)}`;
  }
  return `${head}<h3 class="u-tokhead">Claude Code tokens</h3>
    <div class="u-stats">${stat("Today", c.today)}${stat("Last 7 days", c.week)}</div>
    ${typesHtml(c.week)}
    ${columnsHtml(c.days)}
    ${modelsHtml(c.models)}
    ${harnessHtml(u)}
    ${footHtml(u)}`;
}

function stat(label: string, t: Totals): string {
  return `<div class="u-stat">
    <div class="u-label">${label}</div>
    <div class="u-value">${compact(t.output)}</div>
    <div class="u-unit">output tokens</div>
    <div class="u-sub">${compact(t.tokens)} in all · ${t.sessions.toLocaleString("en-US")} ${t.sessions === 1 ? "session" : "sessions"}</div>
    ${t.usd !== null ? `<div class="u-sub"><b>${dollars(t.usd)}</b> API-equivalent</div>` : ""}
  </div>`;
}

function typesHtml(t: Totals): string {
  const rows: [string, number, string?][] = [
    ["Cache read", t.read],
    ["Cache write", t.write],
    ["Input", t.input],
    ["Output", t.output, t.thinking ? `${compact(t.thinking)} thinking` : undefined],
  ];
  return `<dl class="u-types" aria-label="Tokens by type, last 7 days">${rows.map(([k, v, note]) =>
    `<div><dt>${k}</dt><dd>${compact(v)}${note ? ` <small>${note}</small>` : ""}</dd></div>`).join("")}</dl>`;
}

/** 30 columns of output tokens per day; today in the accent, the rest recede. */
function columnsHtml(days: UsageSummary["claude"]["days"]): string {
  const W = 300, H = 64, gap = 2;
  const max = Math.max(1, ...days.map((d) => d.output));
  const bw = (W - gap * (days.length - 1)) / days.length;
  const bars = days.map((d, i) => {
    const x = i * (bw + gap);
    const h = d.output ? Math.max(2, (d.output / max) * H) : 0;
    const today = i === days.length - 1;
    const tip = `${today ? "Today" : day(d.date)}: ${compact(d.output)} output · ${compact(d.tokens)} in all${d.usd !== null && d.output ? ` · ${dollars(d.usd)}` : ""}`;
    const r = Math.min(2, bw / 2, h);
    // Rounded at the data end, square at the baseline.
    const path = h ? `M${x},${H} V${H - h + r} Q${x},${H - h} ${x + r},${H - h} H${x + bw - r} Q${x + bw},${H - h} ${x + bw},${H - h + r} V${H} Z` : "";
    // Pointer only: the table below is the keyboard and screen-reader view, so the panel adds one tab stop, not 30.
    return `<g class="u-col${today ? " today" : ""}" data-tip="${esc(tip)}" aria-hidden="true">
      <rect class="hit" x="${x - gap / 2}" y="0" width="${bw + gap}" height="${H}"/>${path ? `<path d="${path}"/>` : ""}</g>`;
  }).join("");
  const rows = days.slice().reverse().map((d) =>
    `<tr><td>${esc(day(d.date))}</td><td>${compact(d.output)}</td><td>${compact(d.tokens)}</td><td>${d.usd !== null && d.output ? dollars(d.usd) : "–"}</td></tr>`).join("");
  return `<figure class="u-chart">
    <figcaption><span>Output tokens per day</span><span class="u-peak">peak ${compact(max)}</span></figcaption>
    <div class="u-plot"><svg viewBox="0 0 ${W} ${H + 1}" preserveAspectRatio="none" aria-label="Output tokens per day, last ${days.length} days">${bars}<line class="base" x1="0" x2="${W}" y1="${H + 0.5}" y2="${H + 0.5}"/></svg>
    <div class="u-tip" hidden></div></div>
    <div class="u-axis"><span>${esc(day(days[0]!.date))}</span><span>Today</span></div>
    <details class="u-table"><summary>The numbers</summary><table><thead><tr><th>Day</th><th>Output</th><th>All</th><th>API-eq.</th></tr></thead><tbody>${rows}</tbody></table></details>
  </figure>`;
}

function modelsHtml(models: UsageSummary["claude"]["models"]): string {
  const total = models.reduce((s, m) => s + m.output, 0);
  if (!total) return "";
  const fam = new Map<string, { output: number; models: string[] }>();
  for (const m of models) {
    const f = familyOf(m.model);
    const e = fam.get(f) ?? fam.set(f, { output: 0, models: [] }).get(f)!;
    e.output += m.output;
    e.models.push(modelName(m.model));
  }
  const order = [...FAMILIES, "other"].filter((f) => fam.get(f)?.output);
  const label = (f: string) => f === "other" ? "Other" : f[0]!.toUpperCase() + f.slice(1);
  const pct = (v: number) => { const p = (v / total) * 100; return p < 1 ? "<1%" : `${Math.round(p)}%`; };
  const parts = order.map((f) => {
    const e = fam.get(f)!;
    return `<span class="u-seg fam-${f}" style="flex-grow:${e.output}" title="${esc(`${label(f)}: ${compact(e.output)} output (${pct(e.output)})`)}"></span>`;
  }).join("");
  const legend = order.map((f) => {
    const e = fam.get(f)!;
    return `<li><i class="fam-${f}"></i><b>${label(f)}</b><span class="u-models">${esc(e.models.join(", "))}</span><span class="u-num">${compact(e.output)}</span><span class="u-num u-pct">${pct(e.output)}</span></li>`;
  }).join("");
  return `<div class="u-block"><h3>By model, last 7 days <span>output tokens</span></h3>
    <div class="u-segbar" role="img" aria-label="${esc(order.map((f) => `${label(f)} ${pct(fam.get(f)!.output)}`).join(", "))}">${parts}</div>
    <ul class="u-legend">${legend}</ul></div>`;
}

function harnessHtml(u: UsageSummary): string {
  const rows = u.harnesses.filter((h) => h.status !== "missing");
  const withData = rows.filter((h) => h.status === "ok" && h.output > 0);
  const max = Math.max(1, ...withData.map((h) => h.output));
  const bar = (h: HarnessRow) => `<li class="u-h">
      <div class="u-hhead"><b>${esc(h.name)}</b><span class="u-num">${compact(h.output)}</span></div>
      <div class="u-track"><span style="width:${Math.max(0.6, (h.output / max) * 100)}%"></span></div>
      <div class="u-hsub">${h.sessions.toLocaleString("en-US")} ${h.sessions === 1 ? "session" : "sessions"} · ${compact(h.tokens)} tokens in all${h.note ? ` · ${esc(h.note)}` : ""}</div></li>`;
  const quiet = (h: HarnessRow) => {
    const why = h.status === "none" ? h.note ?? "No local data."
      : h.status === "unreadable" ? h.note ?? "Could not read its files."
      : h.lastAt ? `No use in ${u.windowDays} days. Last used ${day(h.lastAt.slice(0, 10))}.`
      : `No use in ${u.windowDays} days.`;
    return `<li class="u-h quiet-h"><b>${esc(h.name)}</b><span>${esc(why)}</span></li>`;
  };
  return `<div class="u-block"><h3>Across harnesses, last ${u.windowDays} days <span>output tokens</span></h3>
    <ul class="u-harness">${withData.sort((a, b) => b.output - a.output).map(bar).join("")}${rows.filter((h) => !withData.includes(h)).map(quiet).join("")}</ul></div>`;
}

function footHtml(u: UsageSummary & { error: string | null }): string {
  const un = u.claude.week.unpricedOutput;
  const unpriced = u.claude.models.filter((m) => m.usd === null).map((m) => modelName(m.model));
  return `<p class="u-foot">Output includes thinking and reasoning. API-equivalent is what Claude Code's tokens would cost at Anthropic's list prices (read ${esc(u.pricing.read)}); on a subscription you pay none of it.${
    un ? ` It leaves out ${compact(un)} output tokens this week from models without a price we trust (${esc(unpriced.join(", "))}).` : ""}${
    u.error ? ` <span class="problem">The last read failed: ${esc(u.error)}</span>` : ""}</p>`;
}

/** Hovering a column shows its day. One set of listeners on the section, set once. */
export function wireUsage(section: HTMLElement): void {
  if (section.dataset.wired) return;
  section.dataset.wired = "1";
  const show = (target: EventTarget | null) => {
    const col = (target as Element | null)?.closest?.<SVGGElement>(".u-col");
    const plot = section.querySelector<HTMLElement>(".u-plot");
    const tip = plot?.querySelector<HTMLElement>(".u-tip");
    if (!plot || !tip) return;
    section.querySelectorAll(".u-col.on").forEach((el) => el.classList.remove("on"));
    if (!col) { tip.hidden = true; return; }
    col.classList.add("on");
    tip.textContent = col.dataset.tip ?? "";
    tip.hidden = false;
    const p = plot.getBoundingClientRect();
    const b = col.getBoundingClientRect();
    const x = b.left + b.width / 2 - p.left;
    tip.style.left = `${Math.min(Math.max(x, tip.offsetWidth / 2), p.width - tip.offsetWidth / 2)}px`;
  };
  section.addEventListener("pointerover", (e) => show(e.target));
  section.addEventListener("pointerleave", () => show(null));
}
