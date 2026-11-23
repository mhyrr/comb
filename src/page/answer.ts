import { GREG, readAgentSession } from "../agents";
import { answerMessage, type Answer, type QueueItem } from "../queue";

export type AnswerDeps = {
  /** Records the answer and its precedent (recordAnswer, bound to the page's home and sink). */
  record: () => Promise<QueueItem>;
  /** Delivers a message to an agent by name (sendToAgent). */
  send: (name: string, message: string) => Promise<{ woke: boolean }>;
  home: string;
};

export type AnswerResult = {
  item: QueueItem;
  woke: boolean;
  /** Set when the filer could not be reached: what happened instead, for the page. */
  notice: string | null;
};

/**
 * Greg's answer to a queue item. It is recorded first, so it never depends on
 * the delivery. When the filer cannot be woken, the answer goes to its
 * parent (Maya when the filer has none, or its parent is Greg), with why.
 */
export async function answerItem(
  item: QueueItem, answer: Answer, note: string | null, model: string | null, deps: AnswerDeps,
): Promise<AnswerResult> {
  const done = await deps.record();
  const message = answerMessage(item, answer, note, model);
  try {
    const { woke } = await deps.send(item.from, message);
    return { item: done, woke, notice: null };
  } catch (err) {
    const why = oneLine((err as Error).message);
    const recorded = await readAgentSession(item.from, deps.home).catch(() => null);
    const parent = recorded?.parent && recorded.parent !== GREG ? recorded.parent : "maya";
    if (parent === item.from) return { item: done, woke: false, notice: `Recorded. ${item.from} couldn't be woken (${why}).` };
    const relay = `${item.from} filed queue item ${item.id} and couldn't be woken to get Greg's answer (${why}). `
      + `Greg's answer is recorded. Act on it for ${item.from}, or wake it when you can. What it would have got:\n\n${message}`;
    try {
      await deps.send(parent, relay);
      return { item: done, woke: false, notice: `Recorded. ${item.from} couldn't be woken, so ${parent} was told.` };
    } catch (err2) {
      return {
        item: done, woke: false,
        notice: `Recorded. ${item.from} couldn't be woken (${why}), and neither could ${parent} (${oneLine((err2 as Error).message)}).`,
      };
    }
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 200);
}
