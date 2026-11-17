/**
 * Greg's messages between Enter and the transcript. The page shows a sent
 * message at once, then drops it when the agent's transcript records the
 * real turn. No Node or DOM imports: the tests run it directly.
 *
 * The transcript has no id from the send, so a turn matches by its text and
 * time: Greg's turn with the same text (whitespace aside), recorded no
 * earlier than SKEW_MS before the send. Each turn settles one message, so
 * sending "go" twice needs two turns, and an old "go" settles nothing.
 */

export type OutState = "sending" | "sent" | "failed";

export type Outgoing = {
  id: string;
  to: string;
  text: string;
  /** When Greg pressed Enter (ms since epoch). */
  at: number;
  state: OutState;
  /** The agent was asleep and the send is waking it. */
  woke?: boolean;
  error?: string;
};

/** The feed events that can settle a message: Greg's own turns. */
export type Turn = { k: string; from?: string; text?: string; at: string };

/** The transcript's clock and the browser's are one machine's, but allow for write delay ordering. */
export const SKEW_MS = 5_000;
/** A message the server took but the transcript never shows stops showing after this. */
export const SENT_TTL_MS = 10 * 60_000;

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The messages still waiting for their turn, in send order. A failed message
 * stays until Greg retries or sends again, even if a turn matches: a failure
 * must not vanish without his seeing it, unless the turn proves it arrived.
 */
export function unsettled(out: readonly Outgoing[], turns: readonly Turn[], now = Date.now()): Outgoing[] {
  const mine = turns
    .filter((t) => t.k === "in" && t.from === "greg" && typeof t.text === "string")
    .map((t) => ({ text: norm(t.text!), at: Date.parse(t.at), used: false }));
  const left: Outgoing[] = [];
  for (const o of [...out].sort((a, b) => a.at - b.at)) {
    const want = norm(o.text);
    const hit = mine.find((t) => !t.used && t.text === want && !(t.at < o.at - SKEW_MS));
    if (hit) {
      hit.used = true;
      continue;
    }
    if (o.state === "sent" && now - o.at > SENT_TTL_MS) continue;
    left.push(o);
  }
  return left;
}

/** The small line under a message: what happened to it. */
export function statusLine(o: Outgoing, name: string): string {
  if (o.state === "sending") return "Sending…";
  if (o.state === "failed") return `Not sent. ${o.error ?? "The send failed."}`;
  return o.woke ? `Sent. ${name} was asleep and is waking up.` : "Sent";
}

/**
 * Greg's outgoing messages, shared by every view that shows a transcript.
 * `send` does the network call; views subscribe to redraw.
 */
export class Outbox {
  items: Outgoing[] = [];
  private seq = 0;
  private listeners = new Set<() => void>();

  constructor(private readonly post: (to: string, text: string) => Promise<{ ok: true; woke: boolean } | { ok: false; error: string }>) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  for(to: string): Outgoing[] {
    return this.items.filter((o) => o.to === to);
  }

  /**
   * Sends a new message. A failed message to the same agent with the same
   * text is the one being sent again, so it goes rather than doubling.
   */
  send(to: string, text: string, now = Date.now()): { item: Outgoing; done: Promise<boolean> } {
    this.items = this.items.filter((o) => !(o.to === to && o.state === "failed" && norm(o.text) === norm(text)));
    const item: Outgoing = { id: `out-${now}-${++this.seq}`, to, text, at: now, state: "sending" };
    this.items.push(item);
    this.changed();
    return { item, done: this.deliver(item) };
  }

  /** Sends a failed message again. */
  retry(id: string, now = Date.now()): Promise<boolean> | null {
    const item = this.items.find((o) => o.id === id && o.state === "failed");
    if (!item) return null;
    item.state = "sending";
    item.error = undefined;
    item.at = now;
    this.changed();
    return this.deliver(item);
  }

  /** Drops the messages the transcript has caught up with. */
  settle(to: string, turns: readonly Turn[], now = Date.now()) {
    const keep = new Set(unsettled(this.for(to), turns, now));
    const before = this.items.length;
    this.items = this.items.filter((o) => o.to !== to || keep.has(o));
    return this.items.length !== before;
  }

  private async deliver(item: Outgoing): Promise<boolean> {
    const r = await this.post(item.to, item.text);
    if (r.ok) {
      item.state = "sent";
      item.woke = r.woke;
    } else {
      item.state = "failed";
      item.error = r.error;
    }
    this.changed();
    return r.ok;
  }
}
