import { expect, test } from "bun:test";

import { Outbox, SENT_TTL_MS, statusLine, unsettled, type Outgoing, type Turn } from "../page/ui/outbox";

const T0 = Date.parse("2026-11-17T22:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const turn = (text: string, at: number, from = "greg"): Turn => ({ k: "in", from, text, at: iso(at) });
const out = (text: string, at: number, state: Outgoing["state"] = "sent", id = text): Outgoing => ({ id, to: "maya", text, at, state });

/** A post the test settles by hand, so it can look at the in-between state. */
function gate() {
  let open!: (r: { ok: true; woke: boolean } | { ok: false; error: string }) => void;
  const calls: string[] = [];
  const post = (_to: string, text: string) => {
    calls.push(text);
    return new Promise<{ ok: true; woke: boolean } | { ok: false; error: string }>((r) => { open = r; });
  };
  return { post, calls, answer: (r: Parameters<typeof open>[0]) => open(r) };
}

test("a message shows as sending, then sent, then gives way to its real turn with no duplicate", async () => {
  const g = gate();
  const box = new Outbox(g.post);
  const { done } = box.send("maya", "Ship it", T0);
  expect(box.for("maya").map((o) => o.state)).toEqual(["sending"]);

  g.answer({ ok: true, woke: false });
  expect(await done).toBe(true);
  expect(box.for("maya").map((o) => o.state)).toEqual(["sent"]);

  // Not yet in the transcript: it stays.
  box.settle("maya", [turn("older words", T0 - 60_000)], T0 + 2_000);
  expect(box.for("maya")).toHaveLength(1);

  // The transcript records the turn: the optimistic copy goes, so one shows.
  box.settle("maya", [turn("Ship it", T0 + 1_500)], T0 + 2_000);
  expect(box.for("maya")).toEqual([]);
});

test("a failed send keeps its text, says why, and Retry delivers it", async () => {
  const g = gate();
  const box = new Outbox(g.post);
  const { item, done } = box.send("maya", "Ship it", T0);
  g.answer({ ok: false, error: "comb's server is not answering." });
  expect(await done).toBe(false);
  expect(item.state).toBe("failed");
  expect(item.text).toBe("Ship it");
  expect(statusLine(item, "Maya")).toBe("Not sent. comb's server is not answering.");

  // A failure never settles away by time, and never looks sent.
  box.settle("maya", [], T0 + SENT_TTL_MS * 2);
  expect(box.for("maya")).toEqual([item]);

  const again = box.retry(item.id, T0 + 5_000)!;
  expect(item.state).toBe("sending");
  g.answer({ ok: true, woke: true });
  expect(await again).toBe(true);
  expect(statusLine(item, "Maya")).toBe("Sent. Maya was asleep and is waking up.");
  expect(g.calls).toEqual(["Ship it", "Ship it"]);
});

test("sending the same text again replaces the failed copy instead of doubling it", async () => {
  const g = gate();
  const box = new Outbox(g.post);
  const first = box.send("maya", "Ship it", T0);
  g.answer({ ok: false, error: "No." });
  await first.done;
  box.send("maya", "Ship  it\n", T0 + 3_000);
  expect(box.for("maya").map((o) => o.state)).toEqual(["sending"]);
});

test("an old turn with the same words does not settle a new message", () => {
  // Greg said "go" an hour ago and says it again now.
  const left = unsettled([out("go", T0)], [turn("go", T0 - 3_600_000)], T0 + 1_000);
  expect(left.map((o) => o.text)).toEqual(["go"]);
});

test("each turn settles one message: two sends of the same words need two turns", () => {
  const sent = [out("go", T0, "sent", "a"), out("go", T0 + 1_000, "sent", "b")];
  expect(unsettled(sent, [turn("go", T0 + 500)], T0 + 2_000).map((o) => o.id)).toEqual(["b"]);
  expect(unsettled(sent, [turn("go", T0 + 500), turn("go", T0 + 1_400)], T0 + 2_000)).toEqual([]);
});

test("only Greg's own turns settle his messages, whitespace aside", () => {
  const msg = [out("Line one\n\nline two", T0)];
  expect(unsettled(msg, [turn("Line one\n\nline two", T0 + 100, "comb-chat-turns")], T0)).toHaveLength(1);
  expect(unsettled(msg, [{ k: "say", text: "Line one\n\nline two", at: iso(T0 + 100) }], T0)).toHaveLength(1);
  expect(unsettled(msg, [turn("  Line one\nline two ", T0 + 100)], T0)).toEqual([]);
});

test("a turn a moment before the send, by clock skew, still settles it", () => {
  expect(unsettled([out("go", T0)], [turn("go", T0 - 2_000)], T0)).toEqual([]);
});

test("an accepted message the transcript never shows stops showing after a while", () => {
  expect(unsettled([out("go", T0)], [], T0 + SENT_TTL_MS - 1)).toHaveLength(1);
  expect(unsettled([out("go", T0)], [], T0 + SENT_TTL_MS + 1)).toEqual([]);
  // A message still sending is not dropped by age.
  expect(unsettled([out("go", T0, "sending")], [], T0 + SENT_TTL_MS + 1)).toHaveLength(1);
});

test("messages to other agents are left alone", async () => {
  const box = new Outbox(async () => ({ ok: true, woke: false }));
  await box.send("maya", "go", T0).done;
  await box.send("comb-x", "go", T0).done;
  box.settle("maya", [turn("go", T0 + 100)], T0 + 200);
  expect(box.items.map((o) => o.to)).toEqual(["comb-x"]);
});
