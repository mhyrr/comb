import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addItem, answerMessage, listItems, parseItem, recordAnswer, serializeItem } from "../queue";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "comb-queue-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const base = { kind: "proposal", from: "maya", title: "Start a revrec agent on TK-143", action: "Start revrec on TK-143 and triage the 22 Sobelow findings.", project: "revrec", ticket: "TK-143" };

test("an item is a readable file that round-trips, one line per field", async () => {
  const item = await addItem({ ...base, title: "Start a revrec\nagent on TK-143", body: "## Why\n\nCI is red on main." }, home, new Date("2026-11-12T01:00:00Z"));
  expect(item.id).toBe("2026-11-12-start-a-revrec-agent-on-tk-143");
  const text = await readFile(join(home, "queue", item.id, "item.md"), "utf-8");
  expect(text).toContain("title: Start a revrec agent on TK-143\n");
  expect(text).toContain("## Why\n\nCI is red on main.");
  expect(parseItem(text)).toEqual(item);
  expect(parseItem(serializeItem(item))).toEqual(item);
});

test("the same title twice gets a second id, not an overwrite", async () => {
  const a = await addItem(base, home);
  const b = await addItem(base, home);
  expect(b.id).toBe(`${a.id}-2`);
});

test("an item needs a kind, a title and what happens on go", async () => {
  await expect(addItem({ ...base, kind: "wish" }, home)).rejects.toThrow("kind must be one of");
  await expect(addItem({ ...base, title: "  " }, home)).rejects.toThrow("title");
  await expect(addItem({ ...base, action: "" }, home)).rejects.toThrow("go");
});

test("answering records the status and a precedent with Greg's reason, once", async () => {
  const item = await addItem(base, home);
  const done = await recordAnswer(item.id, "no", "Not before the readout.", home, new Date("2026-11-12T02:00:00Z"));
  expect(done).toMatchObject({ status: "declined", note: "Not before the readout.", answered: "2026-11-12T02:00:00.000Z" });
  const precedent = await readFile(join(home, "precedents", `${item.id}.md`), "utf-8");
  expect(precedent).toContain("- Greg: not now");
  expect(precedent).toContain("- Why: Not before the readout.");
  await expect(recordAnswer(item.id, "go", null, home)).rejects.toThrow("Already answered");
  await expect(recordAnswer("../../etc", "go", null, home)).rejects.toThrow("No such queue item");
});

test("the list holds open items first, then recent answers; stale answers drop off", async () => {
  const old = await addItem({ ...base, title: "Old" }, home, new Date("2026-11-10T00:00:00Z"));
  await recordAnswer(old.id, "go", null, home, new Date("2026-11-10T01:00:00Z"));
  const recent = await addItem({ ...base, title: "Recent" }, home, new Date("2026-11-12T00:00:00Z"));
  await recordAnswer(recent.id, "go", null, home, new Date("2026-11-12T00:30:00Z"));
  await addItem({ ...base, title: "Open" }, home, new Date("2026-11-11T00:00:00Z"));
  await writeFile(join(home, "queue", "junk.md"), "not a folder");
  const list = await listItems(home, 24 * 3600_000, Date.parse("2026-11-12T01:00:00Z"));
  expect(list.map((i) => i.title)).toEqual(["Open", "Recent"]);
});

test("the answer message tells the agent exactly what to do", () => {
  const item = { ...base, id: "x", kind: "proposal" as const, status: "open" as const, created: "", answered: null, note: null, body: "" };
  expect(answerMessage(item, "go", null)).toBe('Greg approved your proposal "Start a revrec agent on TK-143" (queue item x). Go: Start revrec on TK-143 and triage the 22 Sobelow findings.');
  expect(answerMessage(item, "no", "later")).toContain("Do not do it.\n\nHis reason: later");
  expect(answerMessage(item, "redirect", "Do the dependabot batch first.")).toContain("Do this instead: Do the dependabot batch first.");
});

test("Start on a ticket gives Maya everything she needs and tells her not to come back first", async () => {
  const { startTicketMessage } = await import("../page/server");
  const m = startTicketMessage("revrec", "TK-143", "Triage Sobelow findings");
  expect(m).toContain('Start revrec TK-143, "Triage Sobelow findings"');
  expect(m).toContain("Start a task agent for it in the revrec repo, on its own worktree");
  expect(m).toContain("Do not come back to Greg first");
  expect(m).toContain("queue_add");
});
