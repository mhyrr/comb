/**
 * Now's "Tools the agents use" (design doc §4.3): a small grid of the MCP
 * servers and CLIs comb's agents called in the last 7 days, from /api/tools
 * (src/tools.ts). A server failing to connect gets a red dot and a short
 * reason, said in words too. Pure: no DOM, so tests run it.
 */
import type { ToolsReport, ToolTile } from "../../tools";
import { esc } from "./md";

export type ToolsPayload = ({ ready: true; error: string | null } & ToolsReport) | { ready: false; error: string | null };

export type ToolsCtx = {
  /** "Nov 12": the page's short date. Passed in so tests pin it. */
  day: (ms: number) => string;
};

const n = (v: number) => v.toLocaleString("en-US");
const plural = (v: number, one: string) => `${n(v)} ${v === 1 ? one : `${one}s`}`;

/** The second line of a tile: use, or what is wrong. */
export function tileLine(t: ToolTile, c: ToolsCtx): { text: string; bad: boolean } {
  const use = t.calls ? `${plural(t.agents, "agent")} · ${plural(t.calls, t.kind === "cli" ? "run" : "call")}` : "No agent used it this week";
  const h = t.health;
  if (h?.state === "failing") {
    const since = h.since ? ` · ${h.sinceAtLeast ? "since at least" : "since"} ${c.day(Date.parse(h.since))}` : "";
    return { text: `Not connecting · ${h.reason ?? "failed"}${since}`, bad: true };
  }
  if (h?.state === "signin") return { text: `${use} · needs sign-in`, bad: false };
  return { text: use, bad: false };
}

export function toolsHtml(p: ToolsPayload | null, c: ToolsCtx): string {
  const head = `<h2>Tools the agents use <span class="aside">last 7 days</span></h2>`;
  if (!p) return `${head}<p class="quiet">Reading transcripts…</p>`;
  if (!p.ready) return `${head}<p class="${p.error ? "problem" : "quiet"}">${esc(p.error ? `Couldn't read transcripts: ${p.error}` : "Reading transcripts…")}</p>`;
  const tiles = p.tiles.map((t) => {
    const line = tileLine(t, c);
    const label = `${t.name}${t.kind === "cli" ? " (command line)" : ""}: ${line.text}.`;
    return `<div class="tool${line.bad ? " bad" : ""}${t.calls ? "" : " unused"}" role="listitem" aria-label="${esc(label)}">
      <b>${t.kind === "cli" ? `<code>${esc(t.name)}</code> CLI` : esc(t.name)}</b>${line.bad ? `<i class="tool-dot" aria-hidden="true"></i>` : ""}
      <span>${esc(line.text)}</span></div>`;
  }).join("");
  const foot = [
    p.builtins.length ? `Plus built-ins: ${p.builtins.map((b) => `${b.name} ${n(b.calls)}`).join(" · ")}.` : "",
    p.idle.length ? `Connected, unused by agents: ${p.idle.join(", ")}.` : "",
    p.signin.length ? `${plural(p.signin.length, "more server")} ${p.signin.length === 1 ? "waits" : "wait"} for a sign-in nobody has given.` : "",
    p.healthNote ?? "Calls by comb agents only. Health from Claude Code's MCP logs.",
    p.error ? `The last read failed: ${p.error}` : "",
  ].filter(Boolean).join(" ");
  if (!tiles) return `${head}<p class="quiet">No agent called an MCP server or <code>gh</code> this week.</p><p class="tools-foot">${esc(foot)}</p>`;
  return `${head}<div class="tools" role="list">${tiles}</div><p class="tools-foot">${esc(foot)}</p>`;
}
