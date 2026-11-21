/**
 * "Tools the agents use" on Now (design doc
 * docs/design/2026-11-17-now-dashboard.md §4.3): for the last 7 days, each MCP
 * server comb's agents called, with how many agents and calls, the `gh` CLI by
 * the first word of a Bash command (decision 6a), and each server's health
 * from Claude Code's MCP logs (src/mcphealth.ts, decision 7a).
 *
 * Counts come from the usage index's tool calls (name, time, session; never
 * input). Only comb agents' sessions count (decision 6a), so the panel means
 * what its title says. Pure, so tests feed it fixture data.
 */
import type { HealthReport, ServerHealth } from "./mcphealth";
import { serverKey } from "./mcphealth";
import type { ToolRec } from "./usage";

export const TOOLS_WINDOW_MS = 7 * 86_400_000;

export type ToolTile = {
  key: string;
  name: string;
  kind: "mcp" | "cli";
  calls: number;
  agents: number;
  /** Null for a CLI, or for a server with no recent log. */
  health: Pick<ServerHealth, "state" | "reason" | "since" | "sinceAtLeast" | "checkedAt"> | null;
};

export type ToolsReport = {
  /** Used by agents, most calls first; then servers that fail though no agent used them. */
  tiles: ToolTile[];
  /** The busiest built-in tools (Bash, Read, Edit…): name and calls. */
  builtins: { name: string; calls: number }[];
  /** Connected, but no agent called them in the window. */
  idle: string[];
  /** Waiting for a sign-in nobody has given, and unused. */
  signin: string[];
  /** Health could not be read at all, and why. */
  healthNote: string | null;
  /** How many agent calls were counted. */
  total: number;
};

/** `mcp__<server>__<tool>` → the server's key, or null for a built-in tool. */
export function mcpServerOf(tool: string): string | null {
  const m = tool.match(/^mcp__(.+?)__(?!_)/);
  return m ? serverKey(m[1]!) : null;
}

/** A name for a server no log names: drop the claude.ai and plugin prefixes. */
function fallbackName(key: string): string {
  if (key.startsWith("claude_ai_")) return key.slice("claude_ai_".length).replace(/_/g, " ");
  const plugin = key.match(/^plugin_([a-z0-9]+)_(.+)$/);
  return plugin ? plugin[2]! : key;
}

export function countTools(i: {
  now: number;
  calls: ToolRec[];
  /** Which comb agent a session belongs to; undefined for anyone else's. */
  ownerOf: (session: string) => string | undefined;
  health: HealthReport;
}): ToolsReport {
  const from = i.now - TOOLS_WINDOW_MS;
  const used = new Map<string, { kind: "mcp" | "cli"; calls: number; agents: Set<string> }>();
  const builtins = new Map<string, number>();
  let total = 0;
  for (const c of i.calls) {
    if (c.ts < from || c.ts > i.now) continue;
    const agent = i.ownerOf(c.session);
    if (!agent) continue;
    total++;
    const server = mcpServerOf(c.name);
    const key = server ?? (c.cli ? `cli:${c.cli}` : null);
    if (!key) { builtins.set(c.name, (builtins.get(c.name) ?? 0) + 1); continue; }
    const u = used.get(key) ?? used.set(key, { kind: server ? "mcp" : "cli", calls: 0, agents: new Set() }).get(key)!;
    u.calls++;
    u.agents.add(agent);
    // A gh run is also a Bash call: count it there too, so built-ins stay whole.
    if (!server) builtins.set(c.name, (builtins.get(c.name) ?? 0) + 1);
  }
  const health = new Map(i.health.servers.map((s) => [s.key, s]));
  const pick = (s: ServerHealth | undefined) => (s ? { state: s.state, reason: s.reason, since: s.since, sinceAtLeast: s.sinceAtLeast, checkedAt: s.checkedAt } : null);

  const tiles: ToolTile[] = [...used].map(([key, u]) => ({
    key,
    name: u.kind === "cli" ? key.slice(4) : health.get(key)?.name ?? fallbackName(key),
    kind: u.kind,
    calls: u.calls,
    agents: u.agents.size,
    health: u.kind === "cli" ? null : pick(health.get(key)),
  })).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  // A failing server matters even when no agent reached it this week: something may be trying to.
  for (const s of i.health.servers) {
    if (s.state === "failing" && !used.has(s.key)) tiles.push({ key: s.key, name: s.name, kind: "mcp", calls: 0, agents: 0, health: pick(s) });
  }
  return {
    tiles,
    builtins: [...builtins].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls).slice(0, 3),
    idle: i.health.servers.filter((s) => s.state === "ok" && !used.has(s.key)).map((s) => s.name),
    signin: i.health.servers.filter((s) => s.state === "signin" && !used.has(s.key)).map((s) => s.name),
    healthNote: i.health.note,
    total,
  };
}
