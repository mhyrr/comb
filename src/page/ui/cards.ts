/**
 * What each answer on a queue card does, and the queue's keys (design doc
 * docs/design/2026-11-17-now-dashboard.md §4.4, decisions 8a and 9a). Pure:
 * no DOM, so tests run it.
 *
 * Keys: J and K move the current card; G, N and R move focus to that card's
 * Go, Not now or Redirect; Enter, the browser's own, activates the focused
 * button. One key never sends, so a stray keystroke cannot answer an item.
 * Keys do nothing while a text field has focus, or with a modifier held.
 */
import type { QueueItem } from "../../queue";
import { esc } from "./md";

export type Consequence = { label: "Go" | "Not now" | "Redirect"; text: string; filer: boolean };

/** One line per answer: the filer's words when it gave them, else comb's default. */
export function consequences(q: Pick<QueueItem, "action" | "onNo" | "onRedirect" | "from">, who: (name: string) => string): Consequence[] {
  const name = who(q.from);
  return [
    { label: "Go", text: q.action, filer: true },
    { label: "Not now", text: q.onNo ?? `Nothing happens. ${name} hears your reason.`, filer: !!q.onNo },
    { label: "Redirect", text: q.onRedirect ?? `${name} gets your instruction and works from it.`, filer: !!q.onRedirect },
  ];
}

/**
 * The top of a card under its title (D31): "What changes for you" first, when
 * the filer said, then what each answer does. The case follows it. An item
 * filed before `changes` existed shows only the answers.
 */
export function cardLead(q: Pick<QueueItem, "action" | "onNo" | "onRedirect" | "from" | "changes">, who: (name: string) => string): string {
  const changes = q.changes
    ? `<p class="qchanges"><b>What changes for you</b><span>${esc(q.changes)}</span></p>`
    : "";
  return `${changes}<ul class="qout" aria-label="What each answer does">${consequences(q, who).map((c) =>
    `<li><b>${c.label}</b><span${c.filer ? "" : ' class="qdefault"'}>${esc(c.text)}</span></li>`).join("")}</ul>`;
}

/**
 * The queue's three lists: open cards, Greg's answers, and withdrawn items
 * (TK-008). A withdrawal is not an answer, so it never shows as one.
 */
export function splitQueue<T extends Pick<QueueItem, "status">>(queue: T[]): { open: T[]; answered: T[]; withdrawn: T[] } {
  return {
    open: queue.filter((q) => q.status === "open"),
    answered: queue.filter((q) => q.status !== "open" && q.status !== "withdrawn"),
    withdrawn: queue.filter((q) => q.status === "withdrawn"),
  };
}

export type KeyIntent = { move: 1 | -1 } | { focus: "go" | "no" | "redirect" } | null;

/** What a key press means on the queue. Null: not the queue's key, so the page does nothing. */
export function keyIntent(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, typing: boolean): KeyIntent {
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.key) {
    case "j": case "J": return { move: 1 };
    case "k": case "K": return { move: -1 };
    case "g": case "G": return { focus: "go" };
    case "n": case "N": return { focus: "no" };
    case "r": case "R": return { focus: "redirect" };
    default: return null;
  }
}

/** Whether focus is somewhere keys type into: a text field, a select, or editable content. */
export function isTyping(el: { tagName?: string; isContentEditable?: boolean; type?: string } | null): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file"].includes((el.type ?? "text").toLowerCase());
}

/**
 * The current card after a move: the next or previous one, staying at the
 * ends. With no current card (or one that left the queue), the first.
 */
export function stepCard(ids: string[], current: string | null, move: 1 | -1 | 0): string | null {
  if (!ids.length) return null;
  const at = current ? ids.indexOf(current) : -1;
  if (at < 0) return ids[0]!;
  return ids[Math.max(0, Math.min(ids.length - 1, at + move))]!;
}
