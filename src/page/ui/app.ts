/**
 * comb's page, in the browser. Plain TypeScript: hash routes, two kinds of
 * server-sent events (the tree's state, and one transcript per open view),
 * and keyed updates in the rail so a working cell keeps its motion.
 */
import type { Ticket } from "../../hive";
import type { QueueItem } from "../../queue";
import type { FeedEvent } from "../../transcript";
import type { Activity, AgentNode, Now, SessionNode, Snapshot } from "../state";
import { esc, md as markdown } from "./md";
import { admit, holdingPlace, patchList, setHtml } from "./patch";
import { treeOrder } from "./tree";
import { refreshPulls } from "./pulls";
import { registerCard } from "./card";
import { nextCell } from "./roving";
import { parseTicketText, ticketSummary } from "./ticket-text";
import { BoxWatch, Outbox, sendStatus, type Outgoing } from "./outbox";
import { usageHtml, wireUsage, type UsagePayload } from "./usage";
import { modelLabel, MODELS, picksModel } from "../../models";

/** Markdown, with "[Screenshot: …/inbox/<file>]" shown as the image itself. */
function md(text: string): string {
  return markdown(text).replace(/\[Screenshot: ([^\]]*\/inbox\/([\w.-]+))\]/g,
    (_, path, file) => `<a class="shot" href="/api/inbox/${file}" target="_blank" rel="noreferrer" title="${path}"><img src="/api/inbox/${file}" alt="Screenshot"></a>`);
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- time

function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
const agoLong = (iso: string | null | undefined) => {
  const a = ago(iso);
  return !a ? "" : a === "now" ? "just now" : `${a} ago`;
};
function clock(iso: string): string {
  const d = new Date(iso);
  return isNaN(+d) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function dayOf(iso: string): string {
  const d = new Date(iso);
  if (isNaN(+d)) return "";
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}
const agoTag = (iso: string | null | undefined, long = false) =>
  iso ? `<time data-ago="${esc(iso)}"${long ? ' data-long="1"' : ""} title="${esc(new Date(iso).toLocaleString())}">${long ? agoLong(iso) : ago(iso)}</time>` : "";
setInterval(() => {
  document.querySelectorAll<HTMLElement>("[data-ago]").forEach((el) => {
    el.textContent = el.dataset.long ? agoLong(el.dataset.ago) : ago(el.dataset.ago);
  });
}, 15_000);

// ---------------------------------------------------------------- cells

const HEX = "M11 1.5 20.5 7v10L11 22.5 1.5 17V7z";
const WAVE = (() => {
  let d = "M-22 2.2";
  for (let x = -22; x < 44; x += 11) d += " q2.75 -2.2 5.5 0 t5.5 0";
  return d + " V30 H-22 Z";
})();
let cellSeq = 0;
function cell(activity: Activity, size = 18): string {
  const id = `cell-${cellSeq++}`;
  return `<svg class="cell ${activity}" width="${size}" height="${Math.round((size * 24) / 22)}" viewBox="0 0 22 24" aria-hidden="true">` +
    `<defs><clipPath id="${id}"><path d="${HEX}"/></clipPath></defs>` +
    `<g clip-path="url(#${id})"><rect class="body" width="22" height="24"/><g class="honey"><path class="wave" d="${WAVE}"/></g></g>` +
    `<path class="rim" d="${HEX}"/></svg>`;
}
function setCell(svg: Element | null, activity: Activity) {
  if (svg && svg.getAttribute("class") !== `cell ${activity}`) svg.setAttribute("class", `cell ${activity}`);
}

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
const count = (n: number) => WORDS[n] ?? String(n);
/** "greg" is the human's internal id (GREG in agents.ts); the page shows the configured name. */
const userName = () => snap?.user.name ?? "You";
const who = (name: string) => (name === "greg" ? userName() : name === "maya" ? "Maya" : name);
/** What a prompt from comb or the harness did, in a few words. */
function combNote(text: string, her = false): string {
  if (text.startsWith("You were restarted")) return `Restarted from ${her ? "her" : "its"} workspace`;
  if (text.startsWith("This session is being continued")) return "Conversation compacted";
  return "Started";
}

function nowLine(now: Now | null, activity: Activity): string {
  if (!now) return activity === "asleep" ? "Asleep" : "";
  if (now.kind === "tool") return `<span class="tool">${esc(now.tool ?? "")}</span><code>${esc(now.text)}</code>`;
  return esc(now.text);
}

// ---------------------------------------------------------------- routes

type Route =
  | { view: "now" }
  | { view: "agent"; name: string; tab: Tab }
  | { view: "session"; id: string }
  | { view: "tickets"; project: string }
  | { view: "memory"; project: string };
type Tab = "activity" | "charter" | "log" | "reports";

function parseRoute(): Route {
  const [, a = "", b = "", c = ""] = location.hash.replace(/^#/, "").split("/").map(decodeURIComponent);
  if (a === "agent" && b) return { view: "agent", name: b, tab: (["activity", "charter", "log", "reports"].includes(c) ? c : "activity") as Tab };
  if (a === "session" && b) return { view: "session", id: b };
  if (a === "tickets") return { view: "tickets", project: b || "all" };
  if (a === "memory") return { view: "memory", project: b };
  return { view: "now" };
}
let route = parseRoute();
window.addEventListener("hashchange", () => {
  const prev = route;
  route = parseRoute();
  renderStage(prev);
  renderRail();
  markNav();
});
function markNav() {
  const v = route.view === "agent" || route.view === "session" ? "" : route.view;
  document.querySelectorAll<HTMLAnchorElement>(".views a").forEach((a) => {
    if (a.dataset.view === v) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

// ---------------------------------------------------------------- data

let snap: Snapshot | null = null;
let connected = false;

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

const state = new EventSource("/api/events");
state.addEventListener("state", (e) => {
  snap = JSON.parse((e as MessageEvent).data);
  connected = true;
  renderPulse();
  renderRail();
  renderMayaHead();
  refreshStageFromSnapshot();
  void refreshPulls(!!snap?.hive); // the top bar's PRs, on every view; throttled inside
});
state.addEventListener("open", () => { connected = true; renderPulse(); });
state.addEventListener("error", () => { connected = false; renderPulse(); });

function allNodes(): (AgentNode | SessionNode)[] {
  return snap ? [...snap.agents, ...snap.mine, ...snap.others] : [];
}
const agentNamed = (name: string) => snap?.agents.find((a) => a.name === name) ?? null;
const sessionWithId = (id: string) => snap ? [...snap.mine, ...snap.others].find((s) => s.sessionId === id) ?? null : null;
const hrefFor = (n: AgentNode | SessionNode) => ("kind" in n ? `#/session/${n.sessionId}` : `#/agent/${n.name}`);

// ---------------------------------------------------------------- feeds

type Tool = Extract<FeedEvent, { k: "tool" }>;

class Feed {
  events: FeedEvent[] = [];
  problem: string | null = null;
  ready = false;
  private tools = new Map<string, Tool>();
  private es: EventSource;

  constructor(query: string, private onChange: () => void) {
    this.es = new EventSource(`/api/feed?${query}`);
    this.es.addEventListener("reset", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { events: FeedEvent[] };
      this.events = [];
      this.tools.clear();
      this.add(data.events);
      this.ready = true;
      this.onChange();
    });
    this.es.addEventListener("events", (e) => {
      this.add(JSON.parse((e as MessageEvent).data));
      this.onChange();
    });
    this.es.addEventListener("problem", (e) => {
      this.problem = JSON.parse((e as MessageEvent).data).message;
      this.onChange();
    });
  }

  private add(list: FeedEvent[]) {
    for (const e of list) {
      if (e.k === "done") {
        const t = this.tools.get(e.ref);
        if (t) t.status = e.ok ? "ok" : "err";
        continue;
      }
      if (e.k === "tool") this.tools.set(e.id, e);
      this.events.push(e);
    }
    if (this.events.length > 800) this.events.splice(0, this.events.length - 800);
  }

  close() { this.es.close(); }
}

/** Runs of tool calls fold into one block; everything else stands alone. */
type Block = { k: "tools"; id: string; at: string; tools: Tool[] } | Exclude<FeedEvent, { k: "tool" } | { k: "done" }>;
function blocks(events: FeedEvent[]): Block[] {
  const out: Block[] = [];
  for (const e of events) {
    if (e.k === "done") continue;
    if (e.k === "tool") {
      const last = out.at(-1);
      if (last?.k === "tools") last.tools.push(e);
      else out.push({ k: "tools", id: e.id, at: e.at, tools: [e] });
    } else {
      out.push(e);
    }
  }
  return out;
}

function toolItem(t: Tool): string {
  const g = t.status === "run" ? '<span class="spin">⬡</span>' : t.status === "err" ? "✕" : "✓";
  return `<li class="${t.status}"><span class="g">${g}</span><span class="n">${esc(t.name)}</span><span class="d">${esc(t.detail)}</span></li>`;
}

/**
 * Renders, then follows new content if the reader was at the bottom. A pinned
 * element (see pinToBottom) lands at the bottom whatever its scroll position.
 * A hidden element has no height, so its scroll position means nothing: it
 * stays pinned until it shows.
 */
function stickToBottom(el: HTMLElement, render: () => void) {
  const atBottom = el.dataset.pin === "1" || el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  const keep = el.scrollTop;
  render();
  if (el.clientHeight === 0) {
    if (atBottom) el.dataset.pin = "1";
    return;
  }
  delete el.dataset.pin;
  el.scrollTop = atBottom ? el.scrollHeight : keep;
}

/** Lands a feed at the bottom on its next render, or now if it is already shown. */
function pinToBottom(el: HTMLElement | null) {
  if (!el) return;
  if (el.clientHeight === 0) {
    el.dataset.pin = "1";
    return;
  }
  delete el.dataset.pin;
  el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------- composer

type SendResult = { ok: true; woke: boolean } | { ok: false; error: string };

async function send(to: string, message: string): Promise<SendResult> {
  try {
    const res = await fetch("/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, message }),
    });
    const data = await res.json();
    return res.ok ? { ok: true, woke: !!data.woke } : { ok: false, error: data.error ?? "Could not send." };
  } catch {
    return { ok: false, error: "comb's server is not answering. Is `comb page` still running?" };
  }
}

/** Greg's messages from every composer, shown in the transcript until their turn arrives. */
const outbox = new Outbox(send);
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function composer(to: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "composer";
  wrap.innerHTML = `<div class="shots"></div><form><textarea rows="1" placeholder="Message ${esc(who(to))}" title="Paste or drop a screenshot to attach it" aria-label="Message ${esc(who(to))}"></textarea><button type="submit" disabled>Send</button></form><p class="hint"></p>`;
  const shotsEl = wrap.querySelector<HTMLElement>(".shots")!;
  const shots: { path: string; url: string }[] = [];
  const drawShots = () => {
    shotsEl.innerHTML = shots.map((s, i) => `<span class="shot-chip"><img src="${esc(s.url)}" alt=""><button type="button" data-drop="${i}" aria-label="Remove screenshot">×</button></span>`).join("");
    btn.disabled = !ta.value.trim() && !shots.length || sending();
  };
  const composed = () => [ta.value.trim(), ...shots.map((s) => `[Screenshot: ${s.path}]`)].filter(Boolean).join("\n\n");
  /** This box's own messages (outbox.ts, BoxWatch). */
  const watch = new BoxWatch(outbox, to);
  /** The box holds a message already on its way: Enter again would send it twice. */
  const sending = () => watch.inFlight(composed());
  shotsEl.addEventListener("click", (e) => {
    const i = (e.target as HTMLElement).closest<HTMLElement>("[data-drop]")?.dataset.drop;
    if (i !== undefined) { shots.splice(Number(i), 1); drawShots(); }
  });
  const addFiles = async (files: File[]) => {
    for (const f of files.filter((f) => f.type.startsWith("image/"))) {
      hint.className = "hint";
      hint.textContent = "Attaching screenshot…";
      try {
        const res = await fetch("/api/upload", { method: "POST", headers: { "content-type": f.type }, body: f });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Upload failed");
        shots.push(data);
        hint.textContent = "";
      } catch (err) {
        hint.className = "hint err";
        hint.textContent = (err as Error).message;
      }
      drawShots();
    }
  };
  const form = wrap.querySelector("form")!;
  const ta = wrap.querySelector("textarea")!;
  const btn = wrap.querySelector("button")!;
  const hint = wrap.querySelector<HTMLElement>(".hint")!;
  const size = () => {
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
    btn.disabled = !ta.value.trim() && !shots.length || sending();
  };
  ta.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.some((f) => f.type.startsWith("image/"))) { e.preventDefault(); void addFiles(files); }
  });
  wrap.addEventListener("dragover", (e) => { e.preventDefault(); wrap.classList.add("drop"); });
  wrap.addEventListener("dragleave", () => wrap.classList.remove("drop"));
  wrap.addEventListener("drop", (e) => { e.preventDefault(); wrap.classList.remove("drop"); void addFiles([...(e.dataTransfer?.files ?? [])]); });
  ta.addEventListener("input", size);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  // The box keeps its text until the server takes the message, so a failed
  // send loses nothing. The message itself shows in the transcript at once
  // (outbox). Once a message sent from this box is accepted, by Enter or by
  // Retry, the box clears if it still holds that message. The watch decides
  // from this box's own messages: the transcript may have settled one out of
  // the outbox before the server answered.
  const off = outbox.subscribe(() => {
    if (!wrap.isConnected) { off(); return; }
    const after = watch.check(composed());
    if (after.clear) {
      ta.value = "";
      shots.length = 0;
      drawShots();
    }
    size();
    if (after.failed.length) {
      hint.className = "hint err";
      hint.dataset.sendErr = "1";
      hint.textContent = after.failedHere
        ? "Not sent. Your message is still here: press Enter, or Retry above, to send it again."
        : "A message did not send. Retry it above.";
    } else if (hint.dataset.sendErr) {
      delete hint.dataset.sendErr;
      hint.className = "hint";
      hint.textContent = "";
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = composed();
    if (!text || sending()) return;
    hint.className = "hint";
    hint.textContent = "";
    delete hint.dataset.sendErr;
    watch.send(text);
  });
  return wrap;
}

// ---------------------------------------------------------------- pulse

function renderPulse() {
  const el = $("pulse");
  if (!connected) {
    el.innerHTML = `<span class="dot off"></span>Reconnecting`;
    return;
  }
  if (snap?.error) {
    el.innerHTML = `<span class="dot off"></span><span title="${esc(snap.error)}">Can't read sessions</span>`;
    return;
  }
  const n = allNodes().filter((x) => x.activity === "working").length;
  el.innerHTML = n ? `<span class="dot on"></span><b>${n}</b> working` : `<span class="dot"></span>All quiet`;
}

// ---------------------------------------------------------------- rail

const rail = $("rail");
rail.innerHTML = `
  <h2>Agents</h2>
  <div class="root-row" id="root-row" hidden><span class="you" id="root-initial"></span><span id="root-name"></span></div>
  <ul id="tree"></ul>
  <button class="fold" id="tree-fold" type="button" hidden></button>
  <ul id="tree-finished" class="finished" hidden></ul>
  <h2>Your sessions <span id="mine-count"></span></h2>
  <ul id="mine"></ul>
  <button class="fold" id="mine-fold" type="button" hidden></button>
  <ul id="mine-finished" class="finished" hidden></ul>
  <h2 id="others-head">Other sessions <span id="others-count"></span></h2>
  <ul id="others"></ul>`;
const expanded = { mine: false, others: false };
// Finished agents and sessions (D22) stay folded until Greg opens them.
const unfolded = { tree: false, mine: false };
for (const which of ["tree", "mine"] as const) {
  $(`${which}-fold`).addEventListener("click", () => { unfolded[which] = !unfolded[which]; renderRail(); });
}

/** The Finished toggle and its list. It opens by itself when the selected row is in it. */
function renderFolded(which: "tree" | "mine", specs: RowSpec[]) {
  const btn = $(`${which}-fold`);
  const ul = $(`${which}-finished`);
  btn.hidden = !specs.length;
  const open = specs.length > 0 && (unfolded[which] || specs.some((s) => s.current));
  ul.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
  const chev = `<svg class="chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const label = `${chev}Finished <span class="count">${specs.length}</span>`;
  if (btn.innerHTML !== label) btn.innerHTML = label;
  reconcile(ul, open ? specs : []);
}

type RowSpec = { key: string; href: string; depth: number; node: AgentNode | SessionNode; current: boolean };

function reconcile(ul: HTMLElement, specs: RowSpec[]) {
  const existing = new Map<string, HTMLElement>();
  ul.querySelectorAll<HTMLElement>(":scope > li").forEach((li) => existing.set(li.dataset.key!, li));
  const order: HTMLElement[] = [];
  for (const s of specs) {
    let li = existing.get(s.key);
    if (!li) {
      li = document.createElement("li");
      li.dataset.key = s.key;
      li.innerHTML = `<a class="row">${cell(s.node.activity)}<span class="name"></span><span class="when"></span><div class="line"></div></a>`;
    }
    existing.delete(s.key);
    const a = li.firstElementChild as HTMLAnchorElement;
    a.href = s.href;
    a.className = `row ${s.node.activity}`;
    a.style.setProperty("--depth", String(s.depth));
    a.style.setProperty("--branch", s.depth > 0 ? "block" : "none");
    if (s.current) a.setAttribute("aria-current", "true");
    else a.removeAttribute("aria-current");
    setCell(a.querySelector("svg"), s.node.activity);
    const name = a.querySelector(".name")!;
    if (name.textContent !== s.node.name) name.textContent = s.node.name;
    a.querySelector(".when")!.innerHTML = agoTag(s.node.lastActive);
    const line = nowLine(s.node.now, s.node.activity);
    const lineEl = a.querySelector(".line")!;
    if (lineEl.innerHTML !== line) lineEl.innerHTML = line;
    order.push(li);
  }
  for (const li of existing.values()) li.remove();
  const same = order.length === ul.children.length && order.every((li, i) => ul.children[i] === li);
  if (!same) order.forEach((li) => ul.appendChild(li));
}

function renderRail() {
  if (!snap) return;
  $("root-initial").textContent = snap.user.initial;
  $("root-name").textContent = snap.user.name;
  $("root-row").hidden = false; // hidden until the first snapshot names the human
  const cur = (n: AgentNode | SessionNode) =>
    "kind" in n ? route.view === "session" && route.id === n.sessionId : route.view === "agent" && route.name === n.name;

  const agentRow = ({ node, depth }: { node: AgentNode; depth: number }): RowSpec =>
    ({ key: `a:${node.name}`, href: hrefFor(node), depth, node, current: cur(node) });
  const tree = treeOrder(snap.agents.filter((a) => !a.finished));
  reconcile($("tree"), tree.map(agentRow));
  if (!tree.length && !snap.agents.length) $("tree").innerHTML = `<li class="note">No agents yet. Ask any session to start one.</li>`;
  renderFolded("tree", treeOrder(snap.agents.filter((a) => a.finished)).map(agentRow));
  renderFolded("mine", snap.mine.filter((s) => s.finished)
    .map((node) => ({ key: `s:${node.sessionId}`, href: hrefFor(node), depth: 0, node, current: cur(node) })));

  for (const which of ["mine", "others"] as const) {
    const list = which === "mine" ? snap.mine.filter((s) => !s.finished) : snap.others;
    const limit = expanded[which] ? list.length : 6;
    const ul = $(which);
    ul.querySelectorAll(":scope > .more-li").forEach((x) => x.remove());
    reconcile(ul, list.slice(0, limit).map((node) => ({ key: `s:${node.sessionId}`, href: hrefFor(node), depth: 0, node, current: cur(node) })));
    if (list.length > 6) {
      const li = document.createElement("li");
      li.className = "more-li";
      // Your sessions are sorted working first, then newest, so the hidden ones are the quiet ones.
      const more = which === "mine" ? `${list.length - 6} more, quiet` : `Show ${list.length - 6} more`;
      li.innerHTML = `<button class="more" type="button">${expanded[which] ? "Show fewer" : more}</button>`;
      li.querySelector("button")!.addEventListener("click", () => { expanded[which] = !expanded[which]; renderRail(); });
      ul.appendChild(li);
    }
    $(`${which}-count`).textContent = list.length ? String(list.length) : "";
  }
  if (!snap.mine.length && !$("mine").children.length) $("mine").innerHTML = `<li class="note">None open.</li>`;
  const hasOthers = snap.others.length > 0;
  $("others-head").hidden = !hasOthers;
  $("others").hidden = !hasOthers;
}

// ---------------------------------------------------------------- Maya

const maya = $("maya");
maya.innerHTML = `
  <div class="maya-head">${cell("asleep", 26)}<div><h2>Maya</h2><p id="maya-state">Chief of staff</p></div>
    <a class="open" href="#/agent/maya">Open</a></div>
  <div class="chat" id="chat"><p class="empty">Reading Maya's conversation…</p></div>`;
maya.appendChild(composer("maya"));
outbox.subscribe(() => { renderChat(); renderTimeline(); });

/** A failed message's Retry, in the Maya pane or the timeline. */
function retryClick(e: Event): boolean {
  const id = (e.target as HTMLElement).closest<HTMLElement>("[data-retry]")?.dataset.retry;
  if (!id) return false;
  void outbox.retry(id);
  return true;
}

/** The line under one of Greg's unsettled messages. Failure reads in red with a Retry. */
function outStatus(o: Outgoing, to: string): string {
  const line = esc(sendStatus(o, who(to)));
  if (o.state === "failed") return `<div class="out-status failed" role="alert">${line} <button type="button" data-retry="${esc(o.id)}">Retry</button></div>`;
  return `<div class="out-status ${o.state}"${o.state === "sending" ? ' aria-live="polite"' : ""}>${line}</div>`;
}
const chatOpen = new Set<string>();

function renderMayaHead() {
  const m = agentNamed("maya");
  setCell(maya.querySelector(".maya-head svg"), m?.activity ?? "asleep");
  const p = $("maya-state");
  if (!m) { p.textContent = "Not set up yet: run comb init"; p.className = ""; return; }
  if (m.activity === "working") {
    p.className = "working";
    p.textContent = m.now?.kind === "tool" ? `Working: ${m.now.tool} ${m.now.text}` : "Working";
  } else {
    p.className = "";
    p.textContent = m.activity === "waiting"
      ? `Chief of staff. Idle for ${ago(m.lastActive) === "now" ? "a moment" : ago(m.lastActive)}`
      : "Chief of staff. Asleep";
  }
}

const mayaFeed = new Feed("agent=maya", () => renderChat());

function renderChat() {
  const chat = $("chat");
  stickToBottom(chat, () => {
    if (!mayaFeed.ready) return;
    const working = agentNamed("maya")?.activity === "working";
    const html: string[] = [];
    let day = "";
    const bl = blocks(mayaFeed.events);
    bl.forEach((b, i) => {
      if (b.k === "idle") return;
      const d = dayOf(b.at);
      if (d && d !== day) { html.push(`<div class="day">${esc(d)}</div>`); day = d; }
      if (b.k === "in") {
        if (b.from === "greg") html.push(`<div class="msg greg"><div class="bubble prose">${md(b.text)}</div></div>`);
        else if (b.from === "comb") html.push(`<div class="day">${esc(combNote(b.text, true))} at ${esc(clock(b.at))}</div>`);
        else html.push(`<div class="msg peer"><div class="from">${esc(who(b.from))}</div><div class="prose">${md(b.text)}</div></div>`);
      } else if (b.k === "say") {
        html.push(`<div class="msg maya-say prose">${md(b.text)}</div>`);
      } else if (b.k === "tools") {
        const live = working && i === bl.length - 1;
        const running = b.tools.findLast((t) => t.status === "run") ?? (live ? b.tools.at(-1) : undefined);
        const open = chatOpen.has(b.id);
        const n = b.tools.length;
        const label = live && running
          ? `<span class="live"><span class="spin">⬡</span> <span class="n">${esc(running.name)}</span> ${esc(running.detail)}</span>`
          : `${open ? "▾" : "▸"} Worked through ${n} step${n === 1 ? "" : "s"}`;
        html.push(`<div class="msg worked"><button type="button" data-group="${esc(b.id)}">${label}</button>${open ? `<ul class="tools">${b.tools.map(toolItem).join("")}</ul>` : ""}</div>`);
      }
    });
    // Greg's messages the transcript has not caught up with yet.
    outbox.settle("maya", mayaFeed.events);
    for (const o of outbox.for("maya")) {
      html.push(`<div class="msg greg out-${o.state}" data-out="${esc(o.id)}"><div><div class="bubble prose">${md(o.text)}</div>${outStatus(o, "maya")}</div></div>`);
    }
    if (mayaFeed.problem) html.push(`<p class="problem">${esc(mayaFeed.problem)}</p>`);
    if (!html.length) html.push(`<p class="empty">Nothing yet. Tell Maya what you want taken off your plate.</p>`);
    chat.innerHTML = html.join("");
  });
}
$("chat").addEventListener("click", (e) => {
  if (retryClick(e)) return;
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-group]");
  if (!btn) return;
  const id = btn.dataset.group!;
  if (chatOpen.has(id)) chatOpen.delete(id); else chatOpen.add(id);
  renderChat();
});

// ---------------------------------------------------------------- stage

const stage = $("stage");
let stageFeed: Feed | null = null;
let stageKey = "";
const timelineOpen = new Set<string>();

function layoutMaya() {
  const centered = route.view === "agent" && route.name === "maya";
  document.body.classList.toggle("maya-off", centered || mayaHidden);
  const t = document.getElementById("maya-toggle");
  if (t) {
    t.hidden = centered;
    t.setAttribute("aria-pressed", String(!mayaHidden));
    t.textContent = mayaHidden ? "Show Maya" : "Hide Maya";
  }
  // The chat may have rendered while hidden. Once it shows, land at the bottom.
  const chat = document.getElementById("chat");
  if (chat?.dataset.pin === "1") pinToBottom(chat);
}
let mayaHidden = (() => { try { return localStorage.getItem("comb.mayaHidden") === "1"; } catch { return false; } })();
document.getElementById("maya-toggle")?.addEventListener("click", () => {
  mayaHidden = !mayaHidden;
  try { localStorage.setItem("comb.mayaHidden", mayaHidden ? "1" : "0"); } catch { /* intentional: private window */ }
  layoutMaya();
});

function renderStage(prev?: Route) {
  layoutMaya();
  const key = route.view === "agent" ? `agent=${route.name}` : route.view === "session" ? `session=${route.id}` : "";
  if (key !== stageKey) {
    stageFeed?.close();
    stageFeed = null;
    stageKey = key;
  }
  const sameEntity = prev && key && ((prev.view === "agent" && route.view === "agent" && prev.name === route.name) || (prev.view === "session" && route.view === "session"));
  if (route.view === "now") return renderNow();
  if (route.view === "tickets") return renderTickets(prev?.view === "tickets");
  if (route.view === "memory") return renderMemory(prev?.view === "memory" && prev.project === route.project);
  renderEntity(!!sameEntity);
}

/** Whether the Tickets or Memory view on screen was drawn with hive on; null before the first snapshot. */
let hiveDrawn: boolean | null = null;

function refreshStageFromSnapshot() {
  if (route.view === "now") renderNow();
  else if (route.view === "agent" || route.view === "session") renderEntityHead();
  else if ((route.view === "tickets" || route.view === "memory") && snap && hiveDrawn !== snap.hive) renderStage();
}

const HIVE_URL = "https://github.com/mhyrr/hive";

/** Tickets and Memory come from hive (D24). Without it, say so and where to get it. */
function noHiveView(title: string): string {
  return `<div class="stage-scroll"><div class="stage-inner">
    <header class="view-head">
      <h1 class="view-title">${title}</h1>
      <p class="view-sub">Install hive for tickets and memory.</p>
    </header>
    <div class="prose no-hive">
      <p>comb runs on plain Claude Code. Agents take their work from their charters and the queue. <a href="${HIVE_URL}" target="_blank" rel="noreferrer">hive</a> adds the rest:</p>
      <ul>
        <li><b>Tickets</b> for each project, here and in every agent's tools, with <b>Start</b> to hand one to Maya.</li>
        <li><b>Memory</b>: what each project has learned, shared by every session.</li>
        <li><b>Identity</b>: your voice and standards in every agent.</li>
        <li><b>Nightly picks</b>: hive's next ticket per project and its briefing's asks, filed in the queue.</li>
      </ul>
      <p>Install hive, then run <code>comb init</code> again. comb finds it on its own.</p>
    </div>
  </div></div>`;
}

// --- Now: the dashboard

type Report = { agent: string; file: string; title: string; summary: string };
let reportsCache: { at: number; list: Report[] } | null = null;
let ticketsAt = 0;
/** Per queue item: an open note form, what was typed, a send in flight, and the model menu and pick. */
type QState = { mode?: "no" | "redirect"; text?: string; busy?: boolean; error?: string; more?: boolean; menu?: boolean; model?: string };
const qState = new Map<string, QState>();
const started = (() => {
  try { return new Set<string>(JSON.parse(localStorage.getItem("comb.started") ?? "[]")); } catch { return new Set<string>(); }
})();
const startState = new Map<string, "busy" | "sent" | string>();

function setSection(id: string, html: string) {
  const el = document.getElementById(id);
  if (el) setHtml(el, html);
}

const kindName: Record<string, string> = { proposal: "Proposal", decision: "Decision", review: "Ready for review", blocker: "Blocked" };
const verdict: Record<string, string> = { approved: "Go", declined: "Not now", redirected: "Redirected" };
/** Queue items on screen. Ones that arrive while Greg is busy with the queue wait behind the pill (D26). */
let qShown = new Set<string>();
let qWaiting = 0;
/** Set by the pill: show every waiting item on the next render. */
let qRelease = false;

function dashScroller(): HTMLElement | null {
  return document.getElementById("dash")?.closest<HTMLElement>(".stage-scroll") ?? null;
}

/**
 * Greg is busy with the queue: something in it has focus, a note form or a
 * case is open, an answer is in flight, or he has scrolled past its top.
 */
function queueBusy(): boolean {
  const q = document.getElementById("now-queue");
  if (!q) return false;
  if (q.contains(document.activeElement)) return true;
  if ([...qState.values()].some((s) => s.mode || s.more || s.busy || s.menu)) return true;
  const scroller = dashScroller();
  return !!scroller && q.getBoundingClientRect().top < scroller.getBoundingClientRect().top - 1;
}

function renderNow() {
  if (!snap) {
    stage.innerHTML = `<div class="empty">Reading…</div>`;
    return;
  }
  if (!document.getElementById("dash")) {
    qShown = new Set();
    stage.innerHTML = `<div class="stage-scroll"><div class="stage-inner dash" id="dash">
      <header class="now-top" id="now-top"></header>
      <div class="dash-grid">
        <div class="dash-main">
          <section class="now-section" id="now-queue">
            <h2 id="q-head"></h2>
            <button type="button" class="qnew" id="q-new" data-qa="shownew" hidden></button>
            <div id="q-cards"></div>
            <div id="q-rest"></div>
          </section>
          <section class="now-section" id="now-live"></section>
          <section class="now-section" id="now-notes"></section>
        </div>
        <section class="now-section dash-tickets" id="now-tickets"></section>
        <aside class="now-section dash-usage usage" id="now-usage" aria-label="Usage"></aside>
        <section class="now-section dash-reports" id="now-reports"></section>
      </div></div></div>`;
    // Back at the top with nothing in hand: let waiting items in.
    dashScroller()?.addEventListener("scroll", () => { if (qWaiting && !queueBusy()) renderNow(); }, { passive: true });
    // Letting go of the queue (blur, closing a form) is the other quiet moment.
    $("now-queue").addEventListener("focusout", () => setTimeout(() => { if (qWaiting && !queueBusy()) renderNow(); }, 0));
  }
  const open = snap.queue.filter((q) => q.status === "open");
  const answered = snap.queue.filter((q) => q.status !== "open");
  const nodes = allNodes();
  const working = nodes.filter((n) => n.activity === "working");

  const head = open.length
    ? `${count(open.length)} ${open.length === 1 ? "thing waits" : "things wait"} on you.`
    : working.length ? `${count(working.length)} at work.` : "All quiet.";
  const names = working.map((n) => n.name);
  const listNames = names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const sub = [
    working.length ? `${listNames} ${working.length === 1 ? "is" : "are"} working right now.` : "Nothing is running.",
    answered.length ? `You answered ${answered.length} today.` : "",
    !open.length && !working.length ? "Start a ticket below, or message Maya." : "",
  ].filter(Boolean).join(" ");
  const release = qRelease;
  qRelease = false;
  const { show, waiting } = admit(open.map((q) => q.id), qShown, !release && queueBusy());
  qShown = new Set(show);
  qWaiting = waiting.length;
  const byId = new Map(open.map((q) => [q.id, q]));

  const draw = () => {
    setSection("now-top", `<h1 class="now-head">${esc(head)}</h1><p class="now-sub">${esc(sub)}</p>`);
    setSection("q-head", `Waiting on you${open.length ? ` <span>${open.length}</span>` : ""}`);
    $("q-new").hidden = !waiting.length;
    if (waiting.length) setSection("q-new", `${count(waiting.length)} new, show`);
    patchList($("q-cards"), show.map((id) => ({ key: id, html: queueCard(byId.get(id)!) })));
    setSection("q-rest", queueRest(open.length, answered));
    setSection("now-live", working.length ? `<h2>Working now</h2>${working.map(liveItem).join("")}` : "");
    setSection("now-notes", notesHtml(nodes));
  };
  if (release) {
    draw();
    $("q-head").scrollIntoView({ block: "start", behavior: "smooth" });
  } else {
    // Rows above the reader may come and go; the one in view stays put.
    holdingPlace(dashScroller(), () => Array.from(document.querySelectorAll<HTMLElement>(
      "#now-top, #q-head, #q-cards > .qcard, #q-rest li, #now-live > *, #now-notes > *")), draw);
  }
  void fillTickets();
  void fillUsage();
  void fillReports();
}

let usageCache: { at: number; data: UsagePayload } | null = null;
let usageBusy = false;
/** The usage panel. The server reads off the request path; this asks at most every 30 seconds, sooner while it is still reading. */
async function fillUsage() {
  const stale = !usageCache || Date.now() - usageCache.at > (usageCache.data.ready ? 30_000 : 3_000);
  if (stale) {
    if (usageBusy) return;
    usageBusy = true;
    try {
      usageCache = { at: Date.now(), data: await getJSON<UsagePayload>("/api/usage") };
    } catch (err) {
      usageCache = { at: Date.now(), data: { ready: false, error: (err as Error).message } };
    } finally {
      usageBusy = false;
    }
    if (!usageCache.data.ready) setTimeout(() => { if (route.view === "now") void fillUsage(); }, 3_100);
  }
  if (route.view !== "now" || !usageCache) return;
  setSection("now-usage", usageHtml(usageCache!.data));
  const el = document.getElementById("now-usage");
  if (el) wireUsage(el);
}

function queueCard(q: QueueItem): string {
  const s = qState.get(q.id) ?? {};
  const k = (part: string) => `data-keep="${esc(`${q.id}:${part}`)}"`;
  const where = [q.project, q.ticket].filter(Boolean).join(" ");
  const form = s.mode
    ? `<form class="qnote" data-q="${esc(q.id)}" data-mode="${s.mode}">
        <textarea rows="2" ${k("note")} placeholder="${s.mode === "redirect" ? "What should it do instead?" : "Why not, if it helps it learn (optional)"}">${esc(s.text ?? "")}</textarea>
        <div><button type="submit" class="primary" ${k("send")}${s.busy ? " disabled" : ""}>${s.mode === "redirect" ? "Send redirect" : "Say not now"}</button><button type="button" data-qa="cancel" ${k("cancel")}>Cancel</button></div></form>`
    : "";
  return `<article class="qcard kind-${q.kind}" data-q="${esc(q.id)}">
    <div class="qmeta"><span class="qkind">${esc(kindName[q.kind] ?? q.kind)}</span><span>from <b>${esc(who(q.from))}</b></span>${where ? `<span>${esc(where)}</span>` : ""}${agoTag(q.created, true)}</div>
    <h3>${esc(q.title)}</h3>
    <p class="qaction"><span>On go</span>${esc(q.action)}</p>
    ${q.body ? (q.body.length > 180 || q.body.includes("\n")
      ? `<div class="qbody prose${s.more ? " open" : ""}">${md(q.body)}</div><button type="button" class="qmore" data-qa="more" ${k("more")}>${s.more ? "Less" : "Read the case"}</button>`
      : `<div class="qbody prose open">${md(q.body)}</div>`) : ""}
    ${form || `<div class="qbtns">
      ${picksModel(q) ? goPicker(q, s, k) : `<button type="button" class="go" data-qa="go" ${k("go")}${s.busy ? " disabled" : ""}>${s.busy ? "Sending…" : "Go"}</button>`}
      <button type="button" data-qa="no" ${k("no")}${s.busy ? " disabled" : ""}>Not now</button>
      <button type="button" data-qa="redirect" ${k("redirect")}${s.busy ? " disabled" : ""}>Redirect</button></div>`}
    ${s.error ? `<p class="problem">${esc(s.error)}</p>` : ""}
  </article>`;
}

/** The model Go will send for this item: Greg's pick, else the filer's, else config.json's default. */
const goModel = (q: QueueItem) => qState.get(q.id)?.model ?? q.model ?? snap?.defaultModel ?? "opus";

/** "Go · Opus ▾": Go sends the shown model; the caret opens the list (D25). */
function goPicker(q: QueueItem, s: QState, k: (part: string) => string): string {
  const pick = goModel(q);
  const off = s.busy ? " disabled" : "";
  const note = (m: string) =>
    m === q.model ? `<small>${esc(who(q.from))}'s pick${q.modelWhy ? `: ${esc(q.modelWhy)}` : ""}</small>`
    : !q.model && m === snap?.defaultModel ? "<small>Your default</small>" : "";
  const menu = s.menu && !s.busy
    ? `<div class="gomenu" role="menu" aria-label="Model">${MODELS.map((m) =>
        `<button type="button" role="menuitemradio" aria-checked="${m === pick}" data-qa="model" data-model="${m}" ${k(`model-${m}`)}><b>${esc(modelLabel(m))}</b>${note(m)}</button>`).join("")}</div>`
    : "";
  return `<div class="gosplit">
    <button type="button" class="go" data-qa="go" ${k("go")}${off}>${s.busy ? "Sending…" : `Go <span class="gom">· ${esc(modelLabel(pick))}</span>`}</button><button type="button" class="go gocaret" data-qa="menu" ${k("menu")} aria-haspopup="menu" aria-expanded="${!!s.menu}" aria-label="Choose the model"${off}>▾</button>
    ${menu}</div>`;
}

function queueRest(openCount: number, answered: QueueItem[]): string {
  if (!openCount && !answered.length) {
    return `<p class="quiet">Nothing. When an agent needs your yes, it lands here with its case and one-click answers.</p>`;
  }
  return `${openCount ? "" : `<p class="quiet">All answered.</p>`}
    ${answered.length ? `<ul class="answered">${answered.map((q) =>
      `<li><span class="v v-${q.status}">${verdict[q.status]}</span><span class="t">${esc(q.title)}</span>${unsynced(q)}<span class="w">${esc(who(q.from))} ${agoTag(q.answered, true)}</span></li>`).join("")}</ul>` : ""}`;
}

/** An answer whose precedent did not reach hive memory (D13): say so, with why and the retry. */
function unsynced(q: QueueItem): string {
  if (!q.hiveSync?.startsWith("not synced")) return "";
  return `<span class="unsynced" title="${esc(`${q.hiveSync}. Retry: comb precedents sync`)}">not in hive memory</span>`;
}

function liveItem(n: AgentNode | SessionNode): string {
  const where = "kind" in n ? (n.project ?? n.cwd.split("/").at(-1) ?? "") : (n.about ?? "");
  const lines = n.recent.map((r) =>
    `<li>${r.kind === "tool" ? `<span class="tool">${esc(r.tool ?? "")}</span><code>${esc(r.text)}</code>` : esc(r.text)}</li>`).join("");
  return `<a class="live-item ${n.activity}" href="${hrefFor(n)}">${cell(n.activity, 30)}<div><div class="who"><b>${esc(n.name)}</b><span>${esc(where)}</span></div><ol>${lines || "<li>Starting</li>"}</ol></div></a>`;
}

function notesHtml(nodes: (AgentNode | SessionNode)[]): string {
  const day = Date.now() - 24 * 3600_000;
  const notes = nodes
    .filter((n) => n.activity !== "working" && n.note && Date.parse(n.note.at) > day)
    .sort((a, b) => b.note!.at.localeCompare(a.note!.at))
    .slice(0, 5);
  if (!notes.length) return "";
  return `<h2>Latest from your sessions</h2>${notes.map((n) =>
    `<a class="note-card" href="${hrefFor(n)}"><div class="nc-head"><b>${esc(n.name)}</b>${agoTag(n.note!.at, true)}</div><div class="prose nc-body">${md(n.note!.text)}</div></a>`).join("")}`;
}

async function fillTickets() {
  if (!snap?.hive) { setSection("now-tickets", ""); return; }
  if (!ticketData || Date.now() - ticketsAt > 60_000) {
    ticketsAt = Date.now();
    try {
      ticketData = await getJSON("/api/tickets");
    } catch (err) {
      setSection("now-tickets", `<h2>Priority tickets</h2><p class="problem">${esc((err as Error).message)}</p>`);
      return;
    }
  }
  if (route.view !== "now" || !ticketData) return;
  const all = ticketData.tickets;
  const urgent = all.filter((t) => t.status === "open" && t.priority <= 1).sort(byRank);
  const progress = all.filter((t) => t.status === "in_progress").length;
  const key = (t: Ticket) => `${t.project}:${t.id}`;
  const row = (t: Ticket) => {
    const st = startState.get(key(t)) ?? (started.has(key(t)) ? "sent" : undefined);
    const btn = st === "busy" ? `<button type="button" class="start" disabled>Sending…</button>`
      : st === "sent" ? `<span class="start-sent">With Maya</span>`
      : `<button type="button" class="start" data-start="${esc(key(t))}">Start</button>`;
    return `<li class="pt"><svg class="tmark" viewBox="0 0 22 24" aria-hidden="true"><path class="tc ${tclass(t)}" d="${HEX}"/></svg>
      <button type="button" class="pt-main" data-project="${esc(t.project)}" data-id="${esc(t.id)}"><span class="pt-title">${esc(t.title)}</span><span class="pt-meta">${esc(t.project)} <span class="mono">${esc(t.id)}</span></span></button>
      ${btn}${st && st !== "busy" && st !== "sent" ? `<p class="problem">${esc(st)}</p>` : ""}</li>`;
  };
  setSection("now-tickets", `<h2>Priority tickets <span>${urgent.length}</span></h2>
    <ul class="pts">${urgent.slice(0, 8).map(row).join("")}</ul>
    <p class="quiet"><a href="#/tickets">${progress} in progress, ${all.length - progress} open across your projects</a></p>`);
}

async function fillReports() {
  if (!reportsCache || Date.now() - reportsCache.at > 30_000) {
    try {
      reportsCache = { at: Date.now(), list: (await getJSON<{ reports: Report[] }>("/api/reports")).reports };
    } catch {
      return; // intentional: the rest of Now stands without reports
    }
  }
  if (route.view !== "now") return;
  setSection("now-reports", reportsCache.list.length ? `<h2>Finished work</h2>${reportsCache.list.slice(0, 5).map((r) =>
    `<a class="report-card" href="#/agent/${encodeURIComponent(r.agent)}/reports"><span class="rc-head"><b>${esc(r.title)}</b></span>${r.summary ? `<span class="rc-sum">${esc(r.summary)}</span>` : ""}<span class="rc-meta">${esc(who(r.agent))}, ${esc(r.file.slice(0, 10))}</span></a>`).join("")}` : "");
}

async function answer(id: string, ans: "go" | "no" | "redirect", note: string, model?: string) {
  const s = qState.get(id) ?? {};
  qState.set(id, { ...s, busy: true, menu: false, error: undefined });
  renderNow();
  try {
    const res = await fetch(`/api/queue/${encodeURIComponent(id)}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: ans, note, ...(model ? { model } : {}) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Could not send the answer.");
    qState.delete(id);
  } catch (err) {
    qState.set(id, { ...s, busy: false, error: (err as Error).message });
  }
  renderNow();
}

stage.addEventListener("click", (e) => {
  if (route.view !== "now") return;
  const t = e.target as HTMLElement;
  const startBtn = t.closest<HTMLElement>("[data-start]");
  if (startBtn) {
    const k = startBtn.dataset.start!;
    const [project, id] = [k.slice(0, k.lastIndexOf(":")), k.slice(k.lastIndexOf(":") + 1)];
    startState.set(k, "busy");
    void fillTickets();
    void (async () => {
      try {
        const res = await fetch("/api/tickets/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project, id }) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Could not reach Maya.");
        startState.set(k, "sent");
        started.add(k);
        try { localStorage.setItem("comb.started", JSON.stringify([...started])); } catch { /* intentional: private window */ }
      } catch (err) {
        startState.set(k, (err as Error).message);
      }
      void fillTickets();
    })();
    return;
  }
  const pt = t.closest<HTMLElement>(".pt-main");
  if (pt) { void openTicket(pt.dataset.project!, pt.dataset.id!); return; }
  const qa = t.closest<HTMLElement>("[data-qa]");
  if (qa?.dataset.qa === "shownew") { qRelease = true; renderNow(); return; }
  const card = t.closest<HTMLElement>(".qcard");
  if (!qa || !card) return;
  const id = card.dataset.q!;
  const s = qState.get(id) ?? {};
  const act = qa.dataset.qa;
  const focusIn = (part: string) => $("q-cards").querySelector<HTMLElement>(`[data-keep="${CSS.escape(`${id}:${part}`)}"]`)?.focus();
  if (act === "go") {
    const q = snap?.queue.find((x) => x.id === id);
    void answer(id, "go", "", q && picksModel(q) ? goModel(q) : undefined);
  } else if (act === "menu") {
    qState.set(id, { ...s, menu: !s.menu });
    renderNow();
    if (!s.menu) focusIn(`model-${$("q-cards").querySelector<HTMLElement>(`[data-key="${CSS.escape(id)}"] [aria-checked="true"]`)?.dataset.model}`);
  } else if (act === "model") {
    qState.set(id, { ...s, menu: false, model: qa.dataset.model });
    renderNow();
    focusIn("go");
  } else if (act === "no" || act === "redirect") {
    qState.set(id, { ...s, mode: act, error: undefined });
    renderNow();
    // The card was re-rendered, so find its new textarea.
    $("q-cards").querySelector<HTMLElement>(`[data-key="${CSS.escape(id)}"] textarea`)?.focus();
  }
  else if (act === "cancel") { qState.set(id, { ...s, mode: undefined, error: undefined }); renderNow(); }
  else if (act === "more") { qState.set(id, { ...s, more: !s.more }); renderNow(); }
});
/** Closes every open model menu but the one `keep` is in; true if any closed. */
function closeMenus(keep?: string): boolean {
  let closed = false;
  for (const [id, s] of qState) if (s.menu && id !== keep) { qState.set(id, { ...s, menu: false }); closed = true; }
  return closed;
}
document.addEventListener("click", (e) => {
  const inside = (e.target as HTMLElement).closest<HTMLElement>(".gosplit")?.closest<HTMLElement>(".qcard")?.dataset.q;
  if (closeMenus(inside) && route.view === "now") renderNow();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || route.view !== "now") return;
  const id = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".qcard")?.dataset.q;
  if (!closeMenus()) return;
  renderNow();
  if (id) $("q-cards").querySelector<HTMLElement>(`[data-keep="${CSS.escape(`${id}:menu`)}"]`)?.focus();
});
stage.addEventListener("input", (e) => {
  const form = (e.target as HTMLElement).closest<HTMLFormElement>(".qnote");
  if (!form) return;
  const id = form.dataset.q!;
  qState.set(id, { ...(qState.get(id) ?? {}), text: (e.target as HTMLTextAreaElement).value });
});
stage.addEventListener("submit", (e) => {
  const form = (e.target as HTMLElement).closest<HTMLFormElement>(".qnote");
  if (!form) return;
  e.preventDefault();
  const id = form.dataset.q!;
  const mode = form.dataset.mode as "no" | "redirect";
  const text = form.querySelector("textarea")!.value.trim();
  if (mode === "redirect" && !text) {
    qState.set(id, { ...(qState.get(id) ?? {}), text, error: "Say what it should do instead." });
    renderNow();
    return;
  }
  void answer(id, mode, text);
});

// --- Entity: an agent or a session

function entity(): AgentNode | SessionNode | null {
  if (route.view === "agent") return agentNamed(route.name);
  if (route.view === "session") return sessionWithId(route.id);
  return null;
}

function renderEntity(same: boolean) {
  const n = entity();
  const name = route.view === "agent" ? route.name : n?.name ?? "Session";
  const isAgent = route.view === "agent";
  const tab: Tab = route.view === "agent" ? route.tab : "activity";
  if (!same) {
    stage.innerHTML = `
      <div class="entity-head">
        <div class="entity-title">${cell(n?.activity ?? "asleep", 36)}<h1>${esc(name)}</h1></div>
        <p class="entity-about" id="ent-about"></p>
        <div class="entity-meta" id="ent-meta"></div>
        <div class="tabs" role="tablist" id="ent-tabs"></div>
      </div>
      <div class="stage-scroll" id="ent-body"></div>
      <div id="ent-composer"></div>`;
    if (n || isAgent) $("ent-composer").appendChild(composer(name));
  }
  const tabs = isAgent ? (["activity", "charter", "log", "reports"] as Tab[]) : (["activity"] as Tab[]);
  $("ent-tabs").innerHTML = tabs.map((t) =>
    `<button role="tab" type="button" aria-selected="${t === tab}" data-tab="${t}">${t[0]!.toUpperCase() + t.slice(1)}</button>`).join("");
  $("ent-tabs").onclick = (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]")?.dataset.tab;
    if (t && isAgent) location.hash = `#/agent/${encodeURIComponent(name)}${t === "activity" ? "" : `/${t}`}`;
  };
  renderEntityHead();

  const body = $("ent-body");
  if (tab === "activity") {
    if (!stageFeed) {
      body.innerHTML = `<div class="empty">Reading the transcript…</div>`;
      stageFeed = new Feed(stageKey, () => renderTimeline());
    } else {
      // Coming from another tab: the body holds that tab's scroll position.
      body.dataset.pin = "1";
      renderTimeline();
    }
  } else {
    void renderDoc(name, tab);
  }
}

function renderEntityHead() {
  const n = entity();
  const head = stage.querySelector(".entity-title svg");
  if (!head) return;
  setCell(head, n?.activity ?? "asleep");
  const about = document.getElementById("ent-about");
  const meta = document.getElementById("ent-meta");
  if (!about || !meta) return;
  if (!n) {
    about.textContent = route.view === "session" ? "This session has closed." : "No agent by this name.";
    meta.innerHTML = "";
    return;
  }
  about.textContent = "kind" in n ? (n.kind === "interactive" ? "Your session" : "Background session") : n.about ?? "";
  const state = n.activity === "working"
    ? `<span class="state-working">Working${n.now?.kind === "tool" ? `: ${esc(n.now.tool ?? "")}` : ""}</span>`
    : n.activity === "waiting" ? "<span>Waiting for a message</span>" : "<span>Asleep</span>";
  const parts = [state];
  if (n.project) parts.push(`<span>${esc(n.project)}</span>`);
  if (n.cwd) parts.push(`<span class="mono">${esc(n.cwd.replace(/^\/Users\/[^/]+/, "~"))}</span>`);
  if (!("kind" in n)) parts.push(`<span>Started by ${esc(who(n.parent))}</span>`);
  if (!("kind" in n) || n.kind === "background") {
    // hive attach resolves a comb agent's live session by id; the user's own
    // background sessions are not comb agents, so they keep claude attach, and
    // so does everything when hive is off.
    const cmd = `${"kind" in n || !snap?.hive ? "claude" : "hive"} attach ${n.name}`;
    parts.push(`<button class="copy" type="button" data-copy="${esc(cmd)}" title="Copy, then paste in a terminal to talk to ${esc(who(n.name))} there">${esc(cmd)}</button>`);
    if (!("kind" in n)) parts.push(`<button class="copy" type="button" data-open="${esc(n.name)}" data-cmd="${esc(cmd)}" title="Open a terminal tab in ${esc(who(n.name))}'s directory running ${esc(cmd)} (also copied)">Open in terminal</button>`);
  }
  if (n.lastActive) parts.push(`<span>Active ${agoTag(n.lastActive, true)}</span>`);
  meta.innerHTML = parts.join("");
}

/** Who the stage's composer writes to: the same name renderEntity gives composer(). */
const stageTo = (): string | null =>
  route.view === "agent" ? route.name : route.view === "session" ? entity()?.name ?? null : null;

/** The open tab. Async renders check it before they write into #ent-body. */
const openTab = (): Tab | null =>
  route.view === "agent" ? route.tab : route.view === "session" ? "activity" : null;

function renderTimeline() {
  const body = document.getElementById("ent-body");
  // The feed outlives a tab switch, so a late event must not overwrite Charter, Log or Reports.
  if (!body || !stageFeed || openTab() !== "activity") return;
  const feed = stageFeed;
  if (!feed.ready && !feed.problem) return; // still "Reading the transcript…"
  stickToBottom(body, () => {
    const html: string[] = [];
    let lastClock = "";
    let day = "";
    for (const b of blocks(feed.events)) {
      const d = dayOf(b.at);
      if (d && d !== day) {
        html.push(`<div class="ev ev-idle"><span class="t"></span><div class="b">${esc(d)}</div></div>`);
        day = d;
      }
      const c = clock(b.at);
      const t = c !== lastClock ? c : "";
      lastClock = c;
      if (b.k === "in") {
        if (b.from === "comb") {
          html.push(`<div class="ev ev-idle"><span class="t">${esc(t)}</span><div class="b">${esc(combNote(b.text))}</div></div>`);
        } else {
          html.push(`<div class="ev ev-in${b.from === "greg" ? " you" : " from-other"}"><span class="t">${esc(t)}</span><div class="b"><div class="from">${esc(who(b.from))}</div><div class="prose">${md(b.text)}</div></div></div>`);
        }
      } else if (b.k === "say") {
        html.push(`<div class="ev ev-say"><span class="t">${esc(t)}</span><div class="b prose">${md(b.text)}</div></div>`);
      } else if (b.k === "idle") {
        const secs = b.ms ? Math.round(b.ms / 1000) : null;
        const dur = secs === null ? "" : secs < 90 ? ` after ${secs}s` : ` after ${Math.round(secs / 60)}m`;
        html.push(`<div class="ev ev-idle"><span class="t"></span><div class="b">Turn ended${dur}</div></div>`);
      } else if (b.k === "tools") {
        const open = timelineOpen.has(b.id);
        const shown = open || b.tools.length <= 8 ? b.tools : b.tools.slice(-6);
        const more = b.tools.length - shown.length;
        html.push(`<div class="ev ev-tools"><span class="t">${esc(t)}</span><div class="b"><ul class="tools">${
          more ? `<li><button class="expand" type="button" data-group="${esc(b.id)}">Show ${more} earlier steps</button></li>` : ""
        }${shown.map(toolItem).join("")}</ul></div></div>`);
      }
    }
    // Greg's messages the transcript has not caught up with yet.
    const to = stageTo();
    if (to && feed.ready) {
      outbox.settle(to, feed.events);
      for (const o of outbox.for(to)) {
        html.push(`<div class="ev ev-in you out-${o.state}" data-out="${esc(o.id)}"><span class="t">${esc(clock(new Date(o.at).toISOString()))}</span><div class="b"><div class="from">${esc(userName())}</div><div class="prose">${md(o.text)}</div>${outStatus(o, to)}</div></div>`);
      }
    }
    if (feed.problem) html.push(`<p class="problem">${esc(feed.problem)}</p>`);
    body.innerHTML = `<div class="timeline">${html.join("") || `<p class="empty">No activity yet.</p>`}</div>`;
  });
}
stage.addEventListener("click", (e) => {
  if (retryClick(e)) return;
  const copy = (e.target as HTMLElement).closest<HTMLElement>("[data-copy]");
  if (copy) {
    void navigator.clipboard.writeText(copy.dataset.copy!).then(() => {
      const was = copy.textContent;
      copy.textContent = "Copied. Paste it in a terminal";
      setTimeout(() => { copy.textContent = was; }, 1800);
    });
    return;
  }
  const open = (e.target as HTMLElement).closest<HTMLElement>("[data-open]");
  if (open) {
    void openTerminal(open);
    return;
  }
  const btn = (e.target as HTMLElement).closest<HTMLElement>(".timeline [data-group]");
  if (!btn) return;
  timelineOpen.add(btn.dataset.group!);
  renderTimeline();
});

/** Asks the page server to open a terminal tab attached to the agent; copies the command too. */
async function openTerminal(btn: HTMLElement) {
  const name = btn.dataset.open!;
  const label = "Open in terminal";
  const copied = navigator.clipboard.writeText(btn.dataset.cmd!).then(() => true, () => false);
  btn.textContent = "Opening…";
  let msg: string;
  try {
    const res = await fetch(`/api/agent/${encodeURIComponent(name)}/terminal`, { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as { via?: string; error?: string; note?: string };
    msg = res.ok ? `Opened in ${body.via === "rex" ? "Rex" : "Terminal"}${body.note ? `. ${body.note[0]!.toUpperCase()}${body.note.slice(1)}` : ""}` : body.error ?? `Failed (${res.status})`;
    if (await copied) msg += ". Command copied";
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  btn.textContent = msg;
  btn.title = msg;
  setTimeout(() => { btn.textContent = label; }, 2600);
}

async function renderDoc(name: string, tab: Tab) {
  const body = $("ent-body");
  body.innerHTML = `<div class="empty">Reading…</div>`;
  try {
    let html = "";
    if (tab === "charter") {
      const [c, k] = await Promise.all([
        getJSON<{ text: string }>(`/api/agent/${encodeURIComponent(name)}/charter`),
        getJSON<{ text: string }>(`/api/agent/${encodeURIComponent(name)}/checklist`),
      ]);
      html = `<div class="prose">${md(c.text)}</div>${k.text.trim() ? `<p class="doc-label">Each time it wakes</p><div class="prose">${md(k.text.replace(/^#.*\n/, ""))}</div>` : ""}`;
    } else if (tab === "log") {
      const { text } = await getJSON<{ text: string }>(`/api/agent/${encodeURIComponent(name)}/log`);
      const lines = text.split("\n").filter((l) => /^\s*-\s/.test(l)).reverse();
      html = lines.length
        ? `<ul class="tools">${lines.map((l) => {
            const m = l.match(/^\s*-\s+(\d{4}-\d\d-\d\dT[\d:.]+Z?)\s+(.*)$/);
            return m
              ? `<li style="align-items:flex-start;padding:6px 0"><span style="width:92px;flex:none;color:var(--faint);font-size:var(--t-xs)">${esc(agoLong(m[1]))}</span><span class="prose">${md(m[2]!)}</span></li>`
              : `<li class="prose">${md(l.replace(/^\s*-\s+/, ""))}</li>`;
          }).join("")}</ul>`
        : `<p class="empty" style="padding:0">Nothing logged yet.</p>`;
    } else {
      const { reports } = await getJSON<{ reports: { file: string; text: string }[] }>(`/api/agent/${encodeURIComponent(name)}/reports`);
      html = reports.length
        ? reports.map((r) => `<article class="report"><div class="report-file">${esc(r.file)}</div><div class="prose">${md(r.text)}</div></article>`).join("")
        : `<p class="empty" style="padding:0">No finished work yet. Reports land here when ${esc(name)} finishes something.</p>`;
    }
    if (openTab() === tab) body.innerHTML = `<div class="doc">${html}</div>`;
  } catch (err) {
    if (openTab() === tab) body.innerHTML = `<div class="doc"><p class="problem">${esc(String((err as Error).message))}</p></div>`;
  }
}

// --- Tickets

let ticketData: { tickets: Ticket[]; failed: string[] } | null = null;
const PRIORITY_NAME = ["Critical", "High", "Medium", "Low"];
const rank = (t: Ticket) => (t.status === "in_progress" ? -1 : t.priority);
const byRank = (a: Ticket, b: Ticket) => rank(a) - rank(b) || a.id.localeCompare(b.id, undefined, { numeric: true });
const tclass = (t: Ticket) => (t.status === "in_progress" ? "prog" : `p${Math.min(t.priority, 3)}`);

/** Tickets as a honeycomb, one cell each, in progress first. Cells open the ticket. */
function comb(tickets: Ticket[], cols: number, r: number): string {
  const w = r * Math.sqrt(3);
  const dy = r * 1.5;
  const rows = Math.max(1, Math.ceil(tickets.length / cols));
  const W = cols * w + w / 2 + 2;
  const H = (rows - 1) * dy + 2 * r + 2;
  const k = r - 0.9;
  const cells = tickets.map((t, i) => {
    const row = Math.floor(i / cols);
    const cx = 1 + w / 2 + (i % cols) * w + (row % 2 ? w / 2 : 0);
    const cy = 1 + r + row * dy;
    const pts = [-90, -30, 30, 90, 150, 210].map((a) => {
      const rad = (a * Math.PI) / 180;
      return `${(cx + k * Math.cos(rad)).toFixed(1)},${(cy + k * Math.sin(rad)).toFixed(1)}`;
    }).join(" ");
    return `<polygon class="tc ${tclass(t)}" points="${pts}" tabindex="${i === 0 ? 0 : -1}" role="button" aria-label="${esc(`${t.id} ${t.title}`)}" data-project="${esc(t.project)}" data-id="${esc(t.id)}"></polygon>`;
  });
  return `<svg class="comb" data-cols="${cols}" viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}" width="${W.toFixed(0)}" height="${H.toFixed(0)}" role="img" aria-label="${tickets.length} tickets">${cells.join("")}</svg>`;
}

const legend = `<div class="legend">
  <span><i class="tc prog"></i>In progress</span><span><i class="tc p0"></i>Critical</span>
  <span><i class="tc p1"></i>High</span><span><i class="tc p2"></i>Medium</span><span><i class="tc p3"></i>Low</span></div>`;

function ticketRow(t: Ticket, showProject: boolean): string {
  const meta = [
    `<span class="mono">${esc(t.id)}</span>`,
    showProject ? `<span>${esc(t.project)}</span>` : "",
    `<span>${esc(t.type)}</span>`,
    t.blockedBy.length ? `<span class="blocked">Blocked by ${esc(t.blockedBy.join(", "))}</span>` : "",
    t.tags.length ? `<span class="tags">${t.tags.slice(0, 4).map((x) => `<em>${esc(x)}</em>`).join("")}</span>` : "",
  ].join("");
  return `<button class="trow" type="button" data-project="${esc(t.project)}" data-id="${esc(t.id)}">
    <svg class="tmark" viewBox="0 0 22 24" aria-hidden="true"><path class="tc ${tclass(t)}" d="${HEX}"/></svg>
    <span class="trow-main"><span class="trow-title">${esc(t.title)}</span><span class="trow-meta">${meta}</span></span></button>`;
}

function ticketGroup(title: string, list: Ticket[], showProject: boolean, limit: number, key: string): string {
  if (!list.length) return "";
  const open = groupsOpen.has(key);
  const shown = open ? list : list.slice(0, limit);
  return `<section class="tgroup"><h3>${esc(title)} <span>${list.length}</span></h3>${shown.map((t) => ticketRow(t, showProject)).join("")}${
    list.length > shown.length ? `<button class="more-line" type="button" data-more="${esc(key)}">Show all ${list.length}</button>` : ""}</section>`;
}
const groupsOpen = new Set<string>();

async function renderTickets(same: boolean, fresh = false) {
  if (!snap) { stage.innerHTML = `<div class="empty">Reading…</div>`; return; }
  hiveDrawn = snap.hive;
  if (!snap.hive) { stage.innerHTML = noHiveView("Tickets"); return; }
  if (!same || fresh || !ticketData) {
    if (!ticketData || fresh) stage.innerHTML = `<div class="empty">Reading tickets from hive…</div>`;
    try {
      ticketData = await getJSON(`/api/tickets${fresh ? "?fresh=1" : ""}`);
    } catch (err) {
      stage.innerHTML = `<div class="empty problem">${esc((err as Error).message)}</div>`;
      return;
    }
  }
  if (route.view !== "tickets") return;
  const project = route.project;
  const all = ticketData!.tickets;
  const byProject = new Map<string, Ticket[]>();
  for (const t of all) byProject.set(t.project, [...(byProject.get(t.project) ?? []), t]);
  const inProgress = (l: Ticket[]) => l.filter((t) => t.status === "in_progress").length;
  const failed = ticketData!.failed.length ? `<p class="problem">Could not read ${esc(ticketData!.failed.join(", "))}.</p>` : "";
  let html: string;

  if (project === "all") {
    const projects = [...byProject.entries()].sort((a, b) => inProgress(b[1]) - inProgress(a[1]) || b[1].length - a[1].length);
    const progress = all.filter((t) => t.status === "in_progress").sort(byRank);
    html = `<div class="stage-scroll"><div class="stage-inner wide">
      <header class="view-head">
        <h1 class="view-title">Tickets</h1>
        <p class="view-sub"><b>${all.length}</b> open across ${projects.length} projects, <b>${progress.length}</b> in progress. <a href="#" id="tickets-refresh">Refresh</a></p>
        ${legend}
      </header>
      ${failed}
      <div class="tiles">${projects.map(([p, list]) => {
        const sorted = [...list].sort(byRank);
        const n = inProgress(list);
        return `<a class="tile" href="#/tickets/${encodeURIComponent(p)}"><span class="tile-head"><b>${esc(p)}</b><span>${n ? `${n} in progress, ` : ""}${list.length - n} open</span></span>${comb(sorted, 14, 7)}</a>`;
      }).join("")}</div>
      ${ticketGroup("In progress", progress, true, 50, "all:prog")}
    </div></div>`;
  } else {
    const list = [...(byProject.get(project) ?? [])].sort(byRank);
    const n = inProgress(list);
    html = `<div class="stage-scroll"><div class="stage-inner wide">
      <header class="view-head">
        <p class="crumb"><a href="#/tickets">All projects</a></p>
        <h1 class="view-title">${esc(project)}</h1>
        <p class="view-sub"><b>${list.length - n}</b> open${n ? `, <b>${n}</b> in progress` : ""}. <a href="#" id="tickets-refresh">Refresh</a></p>
      </header>
      ${failed}
      <div class="hero-comb">${comb(list, 24, 10)}${legend}</div>
      ${ticketGroup("In progress", list.filter((t) => t.status === "in_progress"), false, 50, `${project}:prog`)}
      ${[0, 1, 2, 3].map((p) => ticketGroup(PRIORITY_NAME[p]!, list.filter((t) => t.status === "open" && Math.min(t.priority, 3) === p), false, p <= 1 ? 50 : 6, `${project}:p${p}`)).join("")}
      ${list.length ? "" : `<p class="empty" style="padding:0">No open tickets in ${esc(project)}.</p>`}
    </div></div>`;
  }
  stage.innerHTML = html;
  document.getElementById("tickets-refresh")?.addEventListener("click", (e) => { e.preventDefault(); void renderTickets(true, true); });
}
stage.addEventListener("click", (e) => {
  if (route.view !== "tickets") return;
  const el = e.target as Element;
  const more = el.closest<HTMLElement>("[data-more]");
  if (more) { groupsOpen.add(more.dataset.more!); void renderTickets(true); return; }
  const hit = el.closest<HTMLElement | SVGElement>("[data-id]");
  if (hit) {
    e.preventDefault();
    void openTicket((hit as HTMLElement).dataset.project!, (hit as HTMLElement).dataset.id!);
  }
});

// The hover card on a hex (and on a ticket row): title, state in words, a short summary read lazily.
const STATE_NAME = { in_progress: "In progress", open: "Open", closed: "Closed" } as const;
const summaries = new Map<string, { summary: string; updated: string }>();
const reading = new Map<string, Promise<void>>();
const tkey = (project: string, id: string) => `${project}:${id}`;

function ticketCard(t: Ticket, sum: { summary: string; updated: string } | "reading" | "none"): string {
  const prio = t.status === "in_progress" ? "" : ` · ${PRIORITY_NAME[Math.min(t.priority, 3)] ?? "Unprioritized"} priority`;
  const text = sum === "reading" ? `<span class="tip-line tip-faint"><span>Reading summary…</span></span>`
    : sum === "none" || !sum.summary ? `<span class="tip-line tip-faint"><span>No summary</span></span>`
    : `<span class="tip-line tip-sum"><span>${esc(sum.summary)}</span></span>`;
  const updated = typeof sum === "object" && sum.updated ? ` · updated ${esc(agoLong(sum.updated))}` : "";
  return `<span class="tip-title"><span class="mono">${esc(t.id)}</span> ${esc(t.title)}</span>
    <span class="tip-line"><svg class="pr-ci" viewBox="0 0 22 24" aria-hidden="true"><path class="tc ${tclass(t)}" d="${HEX}"/></svg><span><b>${STATE_NAME[t.status]}</b>${prio}</span></span>
    <span class="tip-line"><span>${esc(t.type)} · ${esc(t.project)}${updated}</span></span>${text}
    ${t.blockedBy.length ? `<span class="tip-line tone-bad"><span><b>Blocked by ${esc(t.blockedBy.join(", "))}</b></span></span>` : ""}
    ${t.tags.length ? `<span class="tip-line tip-faint"><span>${esc(t.tags.join(" · "))}</span></span>` : ""}`;
}

/** One show_ticket read per ticket, kept for the session. A failed read is tried again on the next hover. */
function readSummary(t: Ticket): Promise<void> {
  const k = tkey(t.project, t.id);
  let p = reading.get(k);
  if (!p) {
    p = getJSON<{ text: string }>(`/api/ticket?project=${encodeURIComponent(t.project)}&id=${encodeURIComponent(t.id)}`)
      .then(({ text }) => {
        const { fields, body } = parseTicketText(text);
        summaries.set(k, { summary: ticketSummary(body), updated: fields.get("updated") ?? "" });
      })
      .finally(() => reading.delete(k));
    reading.set(k, p);
  }
  return p;
}

registerCard({
  selector: "svg.comb polygon[data-id], .trow, .pt-main",
  skipTouch: true,
  render(el, update) {
    const t = ticketData?.tickets.find((x) => x.project === (el as HTMLElement).dataset.project && x.id === (el as HTMLElement).dataset.id);
    if (!t) return null;
    const have = summaries.get(tkey(t.project, t.id));
    if (have) return ticketCard(t, have);
    void readSummary(t).then(() => update(ticketCard(t, summaries.get(tkey(t.project, t.id)) ?? "none")), () => update(ticketCard(t, "none")));
    return ticketCard(t, "reading");
  },
});

// One tab stop per grid (the focused hex); arrows move between hexes, Enter or Space opens one.
stage.addEventListener("keydown", (e) => {
  const el = e.target;
  if (route.view !== "tickets" || !(el instanceof SVGElement) || !el.dataset.id) return;
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void openTicket(el.dataset.project!, el.dataset.id); return; }
  const grid = el.closest<SVGElement>("svg.comb");
  if (!grid) return;
  const cells = [...grid.querySelectorAll<SVGElement>("polygon[data-id]")];
  const to = nextCell(e.key, cells.indexOf(el), cells.length, Number(grid.dataset.cols) || 1);
  if (to === null) return;
  e.preventDefault();
  cells[to]!.focus();
});
stage.addEventListener("focusin", (e) => {
  const el = e.target;
  if (!(el instanceof SVGElement) || !el.matches("svg.comb polygon[data-id]")) return;
  el.closest("svg.comb")!.querySelectorAll("polygon[data-id]").forEach((c) => c.setAttribute("tabindex", c === el ? "0" : "-1"));
});

/** hive's show_ticket text: a "# ID: title" line, bold key lines, then the body after ---. */
function ticketDoc(text: string): string {
  const { title, fields, body } = parseTicketText(text);
  const chip = (k: string, cls = "") => (fields.get(k) ? `<span class="chip ${cls}">${esc(fields.get(k)!.replace(/^P\d-/, "").replace("_", " "))}</span>` : "");
  const ref = fields.get("ref");
  const updated = fields.get("updated");
  return `<h2 class="sheet-title">${esc(title)}</h2>
    <div class="chips">${chip("status", "strong")}${chip("priority")}${chip("type")}${(fields.get("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean).map((t) => `<span class="chip faint">${esc(t)}</span>`).join("")}</div>
    <p class="sheet-meta">${updated ? `Updated ${esc(agoLong(updated))}` : ""}${ref && /^https?:\/\//.test(ref) ? ` <a href="${esc(ref)}" target="_blank" rel="noreferrer">${esc(ref.replace(/^https?:\/\/(www\.)?/, ""))}</a>` : ""}</p>
    <div class="prose sheet-body">${md(body)}</div>`;
}

async function openTicket(project: string, id: string) {
  stage.querySelector(".sheet")?.remove();
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", `${project} ${id}`);
  sheet.innerHTML = `<header><span>${esc(project)} <b>${esc(id)}</b></span><button type="button" aria-label="Close">×</button></header><div class="body"><p class="empty" style="padding:0">Reading…</p></div>`;
  stage.appendChild(sheet);
  const close = () => { sheet.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  sheet.querySelector("header button")!.addEventListener("click", close);
  try {
    const { text } = await getJSON<{ text: string }>(`/api/ticket?project=${encodeURIComponent(project)}&id=${encodeURIComponent(id)}`);
    sheet.querySelector(".body")!.innerHTML = ticketDoc(text);
  } catch (err) {
    sheet.querySelector(".body")!.innerHTML = `<p class="problem">${esc((err as Error).message)}</p>`;
  }
}

// --- Memory

type MemoryEntry = { section: "facts" | "conventions" | "decisions" | "questions"; date: string | null; text: string; tags: string[] };
const SECTIONS = [
  { key: "decisions", name: "Decisions" },
  { key: "facts", name: "Facts" },
  { key: "conventions", name: "Conventions" },
  { key: "questions", name: "Open questions" },
] as const;
let projectList: string[] | null = null;
async function projects(): Promise<string[]> {
  if (!projectList) projectList = (await getJSON<{ projects: string[] }>("/api/projects")).projects;
  return projectList;
}
const memoryCache = new Map<string, MemoryEntry[]>();
let memorySection: MemoryEntry["section"] = "decisions";
let memoryFilter = "";
const memoryOpen = new Set<string>();

/** "Topic: the rest" or "First sentence. The rest" into a headline and a body. */
function splitHead(text: string): [string, string] {
  const colon = text.match(/^([^:.]{6,90}):\s+([\s\S]*)$/);
  if (colon) return [colon[1]!, colon[2]!.charAt(0).toUpperCase() + colon[2]!.slice(1)];
  const dot = text.match(/^(.{12,160}?[.?!])\s+([\s\S]*)$/);
  if (dot) return [dot[1]!, dot[2]!];
  return [text, ""];
}

function highlight(html: string, q: string): string {
  if (!q) return html;
  const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  return html.split(/(<[^>]+>)/).map((part) => (part.startsWith("<") ? part : part.replace(re, "<mark>$1</mark>"))).join("");
}

async function renderMemory(same: boolean) {
  if (!snap) { stage.innerHTML = `<div class="empty">Reading…</div>`; return; }
  hiveDrawn = snap.hive;
  if (!snap.hive) { stage.innerHTML = noHiveView("Memory"); return; }
  const list = await projects().catch(() => [] as string[]);
  if (route.view !== "memory") return;
  let project = route.project;
  if (!project || !list.includes(project)) {
    const fromSel = allNodes().find((n) => n.activity === "working" && n.project)?.project;
    project = fromSel && list.includes(fromSel) ? fromSel : list[0] ?? "";
  }
  if (!same) {
    memoryFilter = "";
    stage.innerHTML = `<div class="split">
      <nav aria-label="Projects">${list.map((p) => `<button type="button" data-p="${esc(p)}" aria-pressed="${p === project}">${esc(p)}</button>`).join("")}</nav>
      <div class="stage-scroll"><div class="stage-inner">
        <header class="view-head">
          <h1 class="view-title">${esc(project)}</h1>
          <p class="view-sub">What hive remembers about ${esc(project)}.</p>
        </header>
        <div class="tallies" id="mem-tallies" role="tablist"></div>
        <input class="filter" id="mem-q" type="search" placeholder="Filter ${esc(project)}'s memory" autocomplete="off">
        <div id="mem-body"><p class="empty" style="padding:0">Reading…</p></div>
      </div></div></div>`;
    stage.querySelector("nav")!.addEventListener("click", (e) => {
      const p = (e.target as HTMLElement).closest<HTMLElement>("[data-p]")?.dataset.p;
      if (p) location.hash = `#/memory/${encodeURIComponent(p)}`;
    });
    $<HTMLInputElement>("mem-q").addEventListener("input", (e) => { memoryFilter = (e.target as HTMLInputElement).value.trim(); drawMemory(project); });
    $("mem-tallies").addEventListener("click", (e) => {
      const s = (e.target as HTMLElement).closest<HTMLElement>("[data-s]")?.dataset.s;
      if (s) { memorySection = s as MemoryEntry["section"]; drawMemory(project); }
    });
    $("mem-body").addEventListener("click", (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>("[data-entry]")?.dataset.entry;
      if (!id || (e.target as HTMLElement).closest("a")) return;
      if (memoryOpen.has(id)) memoryOpen.delete(id); else memoryOpen.add(id);
      drawMemory(project);
    });
  }
  if (!memoryCache.has(project)) {
    try {
      memoryCache.set(project, (await getJSON<{ entries: MemoryEntry[] }>(`/api/memory?project=${encodeURIComponent(project)}`)).entries);
    } catch (err) {
      $("mem-body").innerHTML = `<p class="problem">${esc((err as Error).message)}</p>`;
      return;
    }
  }
  if (route.view === "memory") drawMemory(project);
}

function drawMemory(project: string) {
  const entries = memoryCache.get(project) ?? [];
  const q = memoryFilter.toLowerCase();
  const match = (e: MemoryEntry) => !q || e.text.toLowerCase().includes(q) || e.tags.some((t) => t.toLowerCase().includes(q));
  const counts = Object.fromEntries(SECTIONS.map((s) => [s.key, entries.filter((e) => e.section === s.key && match(e)).length]));
  if (!counts[memorySection] && entries.length) {
    memorySection = (SECTIONS.find((s) => counts[s.key])?.key ?? memorySection) as MemoryEntry["section"];
  }
  $("mem-tallies").innerHTML = SECTIONS.map((s) =>
    `<button type="button" role="tab" data-s="${s.key}" aria-selected="${s.key === memorySection}"><b>${counts[s.key]}</b><span>${s.name}</span></button>`).join("");

  const shown = entries
    .map((e, i) => ({ e, id: `${project}:${i}` }))
    .filter(({ e }) => e.section === memorySection && match(e))
    .sort((a, b) => (b.e.date ?? "").localeCompare(a.e.date ?? ""));
  const body = $("mem-body");
  if (!entries.length) { body.innerHTML = `<p class="empty" style="padding:0">hive has nothing on ${esc(project)} yet.</p>`; return; }
  if (!shown.length) { body.innerHTML = `<p class="empty" style="padding:0">Nothing matches “${esc(memoryFilter)}”.</p>`; return; }
  body.innerHTML = `<ol class="notes${memorySection === "questions" ? " questions" : ""}">${shown.map(({ e, id }) => {
    const [head, rest] = splitHead(e.text);
    const open = memoryOpen.has(id) || !!q;
    const d = e.date ? new Date(e.date + "T12:00:00") : null;
    return `<li class="note${open ? " open" : ""}" data-entry="${esc(id)}">
      <span class="note-date">${d ? `<b>${d.toLocaleDateString([], { day: "numeric" })}</b>${esc(d.toLocaleDateString([], { month: "short" }))}` : ""}</span>
      <div><h3>${highlight(esc(head), memoryFilter)}</h3>${rest ? `<p class="note-body">${highlight(esc(rest), memoryFilter)}</p>` : ""}${
        e.tags.length ? `<p class="note-tags">${e.tags.map((t) => `<em>${highlight(esc(t), memoryFilter)}</em>`).join("")}</p>` : ""}</div></li>`;
  }).join("")}</ol>`;
}

// ---------------------------------------------------------------- palette

type Item = { label: string; hint: string; href: string; cellOf?: Activity };
const pal = $("palette");
const palInput = $<HTMLInputElement>("palette-input");
const palList = $("palette-list");
let palItems: Item[] = [];
let palIndex = 0;

async function openPalette() {
  const list = await projects().catch(() => [] as string[]);
  const items: Item[] = [{ label: "Now", hint: "Home", href: "#/" }];
  for (const { node } of treeOrder(snap?.agents ?? [])) items.push({ label: node.name, hint: "Agent", href: hrefFor(node), cellOf: node.activity });
  for (const s of [...(snap?.mine ?? []), ...(snap?.others ?? [])]) items.push({ label: s.name, hint: s.kind === "interactive" ? "Your session" : "Session", href: hrefFor(s), cellOf: s.activity });
  items.push({ label: "All tickets", hint: "Tickets", href: "#/tickets" });
  for (const p of list) items.push({ label: `${p} tickets`, hint: "Tickets", href: `#/tickets/${encodeURIComponent(p)}` });
  for (const p of list) items.push({ label: `${p} memory`, hint: "Memory", href: `#/memory/${encodeURIComponent(p)}` });
  palItems = items;
  pal.hidden = false;
  palInput.value = "";
  palIndex = 0;
  renderPalette();
  palInput.focus();
}
function closePalette() { pal.hidden = true; }

function score(label: string, q: string): number {
  if (!q) return 1;
  const l = label.toLowerCase();
  if (l.startsWith(q)) return 3;
  if (l.includes(q)) return 2;
  let i = 0;
  for (const ch of l) if (ch === q[i]) i++;
  return i === q.length ? 1 : 0;
}
function filtered(): Item[] {
  const q = palInput.value.trim().toLowerCase();
  return palItems.map((it) => ({ it, s: score(it.label, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.it).slice(0, 40);
}
function renderPalette() {
  const items = filtered();
  palIndex = Math.min(palIndex, Math.max(0, items.length - 1));
  palList.innerHTML = items.map((it, i) =>
    `<li role="option" aria-selected="${i === palIndex}" data-i="${i}">${it.cellOf ? cell(it.cellOf, 14) : ""}${esc(it.label)}<small>${esc(it.hint)}</small></li>`).join("")
    || `<li aria-disabled="true">Nothing matches.</li>`;
}
palInput.addEventListener("input", () => { palIndex = 0; renderPalette(); });
palInput.addEventListener("keydown", (e) => {
  const items = filtered();
  if (e.key === "ArrowDown") { e.preventDefault(); palIndex = Math.min(palIndex + 1, items.length - 1); renderPalette(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); palIndex = Math.max(palIndex - 1, 0); renderPalette(); }
  else if (e.key === "Enter") { e.preventDefault(); const it = items[palIndex]; if (it) { location.hash = it.href; closePalette(); } }
  else if (e.key === "Escape") closePalette();
});
palList.addEventListener("click", (e) => {
  const i = (e.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i;
  const it = i !== undefined ? filtered()[Number(i)] : undefined;
  if (it) { location.hash = it.href; closePalette(); }
});
pal.addEventListener("click", (e) => { if (e.target === pal) closePalette(); });
$("find-open").addEventListener("click", () => void openPalette());
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (pal.hidden) void openPalette(); else closePalette();
  }
});

// ---------------------------------------------------------------- start

markNav();
renderStage();
renderPulse();
