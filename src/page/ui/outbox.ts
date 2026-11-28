/**
 * Greg's messages between Enter and the transcript. The page shows a sent
 * message at once, then drops it when the agent's transcript records the
 * real turn. No Node or DOM imports: the tests run it directly.
 *
 * The transcript has no id from the send, so a turn matches by its content and
 * time: Greg's turn with the same text, recorded no earlier than SKEW_MS
 * before the send. Each turn settles one message, so sending "go" twice needs
 * two turns, and an old "go" settles nothing.
 *
 * The text is not always the same byte for byte. A live session gets the
 * message through a small model that retypes it (relayMessage, claude.ts), and
 * that model has turned curly quotes into straight ones (TK-013). So texts
 * compare with whitespace and typography folded, and a message with a
 * screenshot also matches the turn that names the same uploaded files, each of
 * which has a name of its own.
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
  /** The agent could not be woken; its parent got the message instead (TK-011). */
  forwardedTo?: string;
  error?: string;
};

/** The feed events that can settle a message: Greg's own turns. */
export type Turn = { k: string; from?: string; text?: string; at?: string };

/** How far before the send a matching turn may be stamped (one machine, two clocks reading it). */
export const SKEW_MS = 5_000;
/** A message the server took but the transcript never shows stops showing after this. */
export const SENT_TTL_MS = 10 * 60_000;

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Text as the transcript may have it: typography a retype changes, made plain. */
const fold = (s: string) =>
  norm(
    s
      .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
      .replace(/[\u201C-\u201F\u2033]/g, '"')
      .replace(/[\u2010-\u2015\u2212]/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "")
      .normalize("NFKC"), // ellipses, no-break spaces, ligatures
  );

/** The uploaded files a message names, as the composer writes them. "" when it has none. */
const attachments = (s: string) =>
  [...s.matchAll(/\[Screenshot: [^\]]*\/inbox\/([\w.-]+)\]/g)].map((m) => m[1]!).sort().join(" ");

/**
 * The messages still waiting for their turn, in send order. A failed message
 * never ages out: it stays until Greg retries or sends again, or until a
 * matching turn proves it arrived after all.
 */
export function unsettled(out: readonly Outgoing[], turns: readonly Turn[], now = Date.now()): Outgoing[] {
  const mine = turns
    .filter((t) => t.k === "in" && t.from === "greg" && typeof t.text === "string" && typeof t.at === "string")
    .map((t) => ({ text: fold(t.text!), files: attachments(t.text!), at: Date.parse(t.at!), used: false }));
  const sorted = [...out].sort((a, b) => a.at - b.at);
  const settled = new Set<Outgoing>();
  const claim = (o: Outgoing, same: (t: (typeof mine)[number]) => boolean) => {
    const hit = mine.find((t) => !t.used && !(t.at < o.at - SKEW_MS) && same(t));
    if (!hit) return;
    hit.used = true;
    settled.add(o);
  };
  // Every text match goes first, so a screenshot never takes another message's turn.
  for (const o of sorted) {
    const want = fold(o.text);
    claim(o, (t) => t.text === want);
  }
  // Then by screenshot. A failed message goes last: Greg may have edited it and
  // sent it again with the same screenshot, and the turn is the resend's.
  for (const o of [...sorted.filter((o) => o.state !== "failed"), ...sorted.filter((o) => o.state === "failed")]) {
    const files = attachments(o.text);
    if (files && !settled.has(o)) claim(o, (t) => t.files === files);
  }
  return sorted.filter((o) => !settled.has(o) && !(o.state === "sent" && now - o.at > SENT_TTL_MS));
}

/**
 * A transcript's blocks with the waiting messages among them, each at its send
 * time: before the first block stamped after it. Blocks keep their order.
 */
export function inSendOrder<B extends { at: string }>(
  blocks: readonly B[], waiting: readonly Outgoing[],
): ({ block: B } | { out: Outgoing })[] {
  const queue = [...waiting].sort((a, b) => a.at - b.at);
  const rows: ({ block: B } | { out: Outgoing })[] = [];
  for (const block of blocks) {
    const at = Date.parse(block.at);
    while (queue.length && queue[0]!.at < at) rows.push({ out: queue.shift()! });
    rows.push({ block });
  }
  return [...rows, ...queue.map((out) => ({ out }))];
}

/**
 * What a composer does with the messages it sent, given the text its box
 * holds now. The composer keeps its own references: the transcript can record
 * a turn before the server answers the send, and then `settle` has already
 * taken the message out of the outbox while it still reads "sending".
 *
 * - `clear`: a message was accepted and the box still holds its text.
 * - `held`: what to keep watching. A sending message stays even when the
 *   outbox has let it go; a failed one stays while the outbox still shows it
 *   (a resend or a matching turn removes it); an accepted one is done.
 * - `failed`: failed messages still shown, for the hint under the box.
 * - `inFlight`: the box's text is already on its way, so Enter would send it twice.
 */
export function boxAfter(held: readonly Outgoing[], box: string, live: ReadonlySet<string>) {
  const text = norm(box);
  const same = (o: Outgoing) => !!text && norm(o.text) === text;
  const accepted = held.filter((o) => o.state === "sent");
  const failed = held.filter((o) => o.state === "failed" && live.has(o.id));
  const keep = held.filter((o) => o.state === "sending" || failed.includes(o));
  return {
    clear: accepted.some(same),
    held: keep,
    failed,
    failedHere: failed.some(same),
    inFlight: keep.some((o) => o.state === "sending" && same(o)),
  };
}

/**
 * One composer's messages, for boxAfter. app.ts and the tests share it, so
 * the order of send, hold and check is the one the page runs.
 */
export class BoxWatch {
  private held: Outgoing[] = [];

  constructor(private readonly outbox: Outbox, private readonly to: string) {}

  /** Sends the box's text. send() already runs check() once, through the subscriber. */
  send(text: string, now = Date.now()) {
    const { item, done } = this.outbox.send(this.to, text, now);
    this.held.push(item);
    return { item, done };
  }

  /** Call on every outbox change with what the box holds now. */
  check(box: string) {
    const after = boxAfter(this.held, box, new Set(this.outbox.for(this.to).map((o) => o.id)));
    this.held = after.held;
    return after;
  }

  /** The box's text is already on its way. */
  inFlight(box: string): boolean {
    return boxAfter(this.held, box, new Set()).inFlight;
  }
}

/** The small line under a message: what happened to it. */
export function sendStatus(o: Outgoing, name: string): string {
  if (o.state === "sending") return "Sending…";
  if (o.state === "failed") return `Not sent. ${o.error ?? "The send failed."}`;
  if (o.forwardedTo) return `Not delivered: ${name} could not be woken. ${o.forwardedTo} has the message instead.`;
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

  constructor(private readonly post: (to: string, text: string) => Promise<{ ok: true; woke: boolean; forwardedTo?: string } | { ok: false; error: string }>) {}

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
      item.forwardedTo = r.forwardedTo;
    } else {
      item.state = "failed";
      item.error = r.error;
    }
    this.changed();
    return r.ok;
  }
}
