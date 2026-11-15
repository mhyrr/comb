/**
 * The rail's agent tree as an ordered list of rows. No DOM and no Node, so
 * tests can call it directly.
 */
import type { AgentNode } from "../state";

type Row = Pick<AgentNode, "name" | "parent" | "activity" | "lastActive">;

/**
 * Siblings under one parent: maya first, then live work, then the most
 * recent activity, with the name as the last tie-break. Equal ISO strings
 * compare as equal, and a missing time sorts last.
 */
export function bySiblingOrder(x: Row, y: Row): number {
  if (x.name === "maya" || y.name === "maya") return x.name === "maya" ? (y.name === "maya" ? 0 : -1) : 1;
  const live = (r: Row) => (r.activity === "working" ? 0 : 1);
  return live(x) - live(y) || (y.lastActive ?? "").localeCompare(x.lastActive ?? "") || x.name.localeCompare(y.name);
}

/** Depth-first rows; an agent whose parent is not in the list sits under the human. */
export function treeOrder<T extends Row>(agents: T[]): { node: T; depth: number }[] {
  const names = new Set(agents.map((a) => a.name));
  const kids = new Map<string, T[]>();
  for (const a of agents) {
    const p = names.has(a.parent) && a.parent !== a.name ? a.parent : "greg";
    kids.set(p, [...(kids.get(p) ?? []), a]);
  }
  const out: { node: T; depth: number }[] = [];
  const walk = (parent: string, depth: number) => {
    for (const a of (kids.get(parent) ?? []).sort(bySiblingOrder)) {
      out.push({ node: a, depth });
      if (depth < 12) walk(a.name, depth + 1);
    }
  };
  walk("greg", 1);
  return out;
}
