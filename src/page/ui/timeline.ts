/**
 * Now's "What each agent did" block (design doc §4.2): one lane per agent over
 * the last 24 hours, from /api/timeline (src/timeline.ts), with each agent's
 * state now taken from the live snapshot. Honey bars are turns (honey only
 * ever means working); rings are asks; a filled ring was answered; a green
 * hex is a report; a red hex a blocker. Every state is also said in words, so
 * color is never the only signal. Pure: no DOM, so tests run it.
 */
import type { QueueItem } from "../../queue";
import type { Lane, Mark, Span, Timeline } from "../../timeline";
import type { AgentNode, SessionNode } from "../state";
import { esc } from "./md";
import { span } from "./strip";

export type TimelinePayload = ({ ready: true; error: string | null } & Timeline) | { ready: false; error: string | null };

export type TimelineCtx = {
  now: number;
  agents: Pick<AgentNode, "name" | "activity" | "about">[];
  mine: Pick<SessionNode, "activity">[];
  queue: Pick<QueueItem, "status" | "kind" | "from" | "created">[];
  who: (name: string) => string;
  userName: string;
  /** "3:05 PM": the page's clock format. Passed in so tests pin it. */
  clock: (ms: number) => string;
  /** "3 PM", for the axis. */
  hour: (ms: number) => string;
};

export type LaneState = { word: string; sub: string; tone: "working" | "waiting" | "blocked" | "done" | "quiet" };

const HEX = "M11 1.5 20.5 7v10L11 22.5 1.5 17V7z";

/** An agent's state now, in words, from the snapshot and the open queue. */
export function laneState(lane: Lane, c: TimelineCtx): LaneState {
  const node = c.agents.find((a) => a.name === lane.name);
  const open = c.queue.filter((q) => q.status === "open" && q.from === lane.name);
  const oldest = (qs: typeof open) => span(c.now - Math.min(...qs.map((q) => Date.parse(q.created))));
  const blockers = open.filter((q) => q.kind === "blocker");
  const asks = open.filter((q) => q.kind !== "blocker");
  if (node?.activity === "working") {
    return { word: "Working", sub: lane.openSince ? `${span(c.now - lane.openSince)} on this turn` : "on a turn", tone: "working" };
  }
  if (blockers.length) return { word: "Blocked", sub: oldest(blockers), tone: "blocked" };
  if (asks.length) return { word: asks.length === 1 ? "Waiting on you" : `${asks.length} waiting`, sub: oldest(asks), tone: "waiting" };
  const done = [...lane.marks].reverse().find((m) => m.kind === "finished");
  if (done) return { word: "Finished", sub: `report ${c.clock(done.at)}`, tone: "done" };
  const last = lane.spans.at(-1)?.e ?? lane.last;
  return { word: node?.activity === "asleep" ? "Asleep" : "Idle", sub: `since ${c.clock(last)}`, tone: "quiet" };
}

const names = (xs: string[]) =>
  xs.length <= 2 ? xs.map((x) => `<b>${esc(x)}</b>`).join(" and ") : `<b>${esc(xs[0]!)}</b>, <b>${esc(xs[1]!)}</b> and ${xs.length - 2} more`;

/** The night in one sentence: when the user was away, then who finished, who waits on them, who still works. */
export function summaryLine(t: Timeline, c: TimelineCtx): string {
  const parts: string[] = [];
  const away = t.away;
  const toNow = away && c.now - away.e < 60_000;
  if (away) parts.push(toNow ? `You've been away since ${esc(c.clock(away.s))}.` : `You were away ${esc(c.clock(away.s))}–${esc(c.clock(away.e))}.`);
  const from = away?.s ?? t.start;
  const states = new Map(t.lanes.map((l) => [l.name, laneState(l, c)]));
  const finished = t.lanes.filter((l) => l.marks.some((m) => m.kind === "finished" && m.at >= from)).map((l) => c.who(l.name));
  const waiting = t.lanes.filter((l) => ["waiting", "blocked"].includes(states.get(l.name)!.tone)).map((l) => c.who(l.name));
  const working = t.lanes.filter((l) => states.get(l.name)!.tone === "working").map((l) => c.who(l.name));
  const said: string[] = [];
  if (finished.length) said.push(`${names(finished)} finished`);
  if (waiting.length) said.push(`${names(waiting)} ${waiting.length === 1 ? "is" : "are"} waiting on you`);
  if (working.length) said.push(`${names(working)} ${working.length === 1 ? "is" : "are"} still working`);
  if (said.length) parts.push(`${said.join("; ")}.`.replace(/^./, (x) => x.toUpperCase()));
  else if (!t.lanes.length) parts.push("No agent did anything in the last 24 hours.");
  return parts.join(" ");
}

function pct(t: Timeline, ms: number): number {
  return Math.max(0, Math.min(100, ((ms - t.start) / (t.end - t.start)) * 100));
}

function barTitle(s: Span, c: TimelineCtx, live = false): string {
  const len = span(s.e - s.s);
  return `${c.clock(s.s)}–${live ? "now" : c.clock(s.e)} · ${live ? "working" : "worked"} ${len}` +
    (s.turns > 1 ? ` · ${s.turns} turns` : "") + (s.calls ? ` · ${s.calls} tool ${s.calls === 1 ? "call" : "calls"}` : "");
}

function markHtml(t: Timeline, m: Mark, c: TimelineCtx): string {
  const left = `left:${pct(t, m.at).toFixed(2)}%`;
  if (m.kind === "finished") {
    return `<i class="tl-mk tl-hex done" style="${left}" title="${esc(`Report ${c.clock(m.at)}: ${m.file}`)}"><svg viewBox="0 0 22 24" aria-hidden="true"><path d="${HEX}"/></svg></i>`;
  }
  const what = m.kind === "blocked" ? "Blocked" : "Asked you";
  const ans = m.answeredAt ? `, answered ${c.clock(m.answeredAt)}` : ", still open";
  const tip = esc(`${what} ${c.clock(m.at)}${ans}: ${m.title}`);
  if (m.kind === "blocked") return `<i class="tl-mk tl-hex blocked" style="${left}" title="${tip}"><svg viewBox="0 0 22 24" aria-hidden="true"><path d="${HEX}"/></svg></i>`;
  return `<i class="tl-mk tl-ring${m.answeredAt ? " answered" : ""}" style="${left}" title="${tip}"></i>`;
}

function track(t: Timeline, spans: Span[], c: TimelineCtx, opts: { you?: boolean; marks?: Mark[]; live?: number | null } = {}): string {
  const away = t.away ? `<i class="tl-away" style="left:${pct(t, t.away.s).toFixed(2)}%;width:${(pct(t, t.away.e) - pct(t, t.away.s)).toFixed(2)}%"></i>` : "";
  const bar = (s: Span, live = false) => {
    const l = pct(t, s.s);
    const w = Math.max(0.35, pct(t, s.e) - l);
    return `<i class="tl-bar${opts.you ? " you" : ""}${live ? " live" : ""}" style="left:${l.toFixed(2)}%;width:${w.toFixed(2)}%" title="${esc(barTitle(s, c, live))}"></i>`;
  };
  const bars = spans.map((s) => bar(s)).join("");
  const live = opts.live ? bar({ s: opts.live, e: t.end, turns: 1, calls: 0 }, true) : "";
  return `<div class="tl-track">${away}${bars}${live}${(opts.marks ?? []).map((m) => markHtml(t, m, c)).join("")}</div>`;
}

/** What a screen reader hears for a lane: the same facts as the marks, in words. */
function laneLabel(lane: Lane, st: LaneState, c: TimelineCtx): string {
  const worked = lane.spans.length
    ? `worked ${lane.spans.map((s) => `${c.clock(s.s)} to ${c.clock(s.e)}`).join(", ")}`
    : "no finished turns";
  const asked = lane.marks.filter((m) => m.kind === "asked").length;
  const done = lane.marks.filter((m) => m.kind === "finished").length;
  return `${c.who(lane.name)}: ${worked}${asked ? `, asked you ${asked} ${asked === 1 ? "time" : "times"}` : ""}${done ? `, wrote ${done} ${done === 1 ? "report" : "reports"}` : ""}. Now: ${st.word}, ${st.sub}.`;
}

function ticks(t: Timeline, c: TimelineCtx): string {
  const out: string[] = [];
  const d = new Date(t.start);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  while (d.getHours() % 3) d.setHours(d.getHours() + 1);
  // Stop 2.5 hours short of the end, so the last hour label never runs into "now".
  for (; d.getTime() < t.end - 150 * 60_000; d.setHours(d.getHours() + 3)) {
    out.push(`<span style="left:${pct(t, d.getTime()).toFixed(2)}%">${esc(c.hour(d.getTime()))}</span>`);
  }
  return out.join("") + `<span class="now" style="left:100%">now</span>`;
}

export function timelineHtml(p: TimelinePayload | null, c: TimelineCtx, href: (name: string) => string): string {
  const head = `<h2>What each agent did <span class="aside">last 24 hours</span></h2>`;
  if (!p) return `${head}<p class="quiet">Reading transcripts…</p>`;
  if (!p.ready) return `${head}<p class="${p.error ? "problem" : "quiet"}">${esc(p.error ? `Couldn't read transcripts: ${p.error}` : "Reading transcripts…")}</p>`;
  const t = p;
  // Maya first, then whoever is working, then the server's order (latest first).
  const work = (l: Lane) => (c.agents.find((a) => a.name === l.name)?.activity === "working" ? 0 : 1);
  const lanes = [...t.lanes].sort((a, b) => (a.name === "maya" ? -1 : b.name === "maya" ? 1 : work(a) - work(b)));
  const rows = lanes.map((l) => {
    const st = laneState(l, c);
    const about = c.agents.find((a) => a.name === l.name)?.about ?? "";
    const live = st.tone === "working" ? l.openSince : null;
    return `<div class="tl-lane" role="listitem" aria-label="${esc(laneLabel(l, st, c))}">
      <a class="tl-who" href="${esc(href(l.name))}"><b>${esc(c.who(l.name))}</b>${about ? `<span>${esc(about)}</span>` : ""}</a>
      ${track(t, l.spans, c, { marks: l.marks, live })}
      <div class="tl-state ${st.tone}"><b>${esc(st.word)}</b><span>${esc(st.sub)}</span></div></div>`;
  }).join("");
  const youWorking = c.mine.some((s) => s.activity === "working");
  const youRow = t.you && (t.you.spans.length || youWorking) ? (() => {
    const awayNow = !youWorking && t.away && c.now - t.away.e < 60_000;
    const last = t.you!.spans.at(-1)?.e;
    const st = youWorking ? { word: "Working", sub: "in a session" } : awayNow ? { word: "Away", sub: `since ${c.clock(t.away!.s)}` } : { word: "Here", sub: last ? `last turn ${c.clock(last)}` : "" };
    return `<div class="tl-lane you" role="listitem" aria-label="${esc(`Your sessions: ${t.you!.spans.length} stretches of work. Now: ${st.word}, ${st.sub}.`)}">
      <div class="tl-who"><b>${esc(c.userName)}</b><span>your sessions</span></div>
      ${track(t, t.you!.spans, c, { you: true })}
      <div class="tl-state quiet"><b>${esc(st.word)}</b><span>${esc(st.sub)}</span></div></div>`;
  })() : "";
  const legend = `<div class="tl-legend" aria-hidden="true"><span><i class="lg-bar"></i>Working</span><span><i class="lg-idle"></i>Idle</span>
    <span><i class="lg-ring"></i>Asked you</span><span><i class="lg-ring answered"></i>Answered</span>
    <span><svg class="lg-hex done" viewBox="0 0 22 24"><path d="${HEX}"/></svg>Report</span><span><svg class="lg-hex blocked" viewBox="0 0 22 24"><path d="${HEX}"/></svg>Blocked</span></div>`;
  const foot = [
    "Bars are turns, from each agent's transcripts.",
    t.quiet ? `${t.quiet} more ${t.quiet === 1 ? "agent" : "agents"} did nothing in the last 24 hours.` : "",
    t.youNote ?? "",
    p.error ? `The last read failed: ${p.error}` : "",
  ].filter(Boolean).join(" ");
  const summary = summaryLine(t, c);
  if (!rows && !youRow) return `${head}<p class="quiet">${summary || "No agent did anything in the last 24 hours."}</p><p class="tl-foot">${esc(foot)}</p>`;
  return `${head}${summary ? `<p class="tl-sum">${summary}</p>` : ""}${legend}
    <div class="tl-lanes" role="list">${rows}${youRow}</div>
    <div class="tl-axis" aria-hidden="true"><span></span><div class="tl-ticks">${ticks(t, c)}</div><span></span></div>
    <p class="tl-foot">${esc(foot)}</p>`;
}
