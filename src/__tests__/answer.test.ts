import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentDir } from "../agents";
import { UsageError } from "../errors";
import { answerItem } from "../page/answer";
import { addItem, readItem, recordAnswer, type QueueItem } from "../queue";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "comb-answer-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const base = { kind: "decision", from: "comb-public-ready", title: "Make comb standalone", action: "Split comb from hive." };

/** A send that fails for the names in `down` and records every call. */
function sender(down: string[]) {
  const sent: { name: string; message: string }[] = [];
  const send = async (name: string, message: string) => {
    sent.push({ name, message });
    if (down.includes(name)) throw new UsageError(`Working directory does not exist: /w/.claude/worktrees/${name}`);
    return { woke: true };
  };
  return { sent, send };
}

async function answer(item: QueueItem, send: ReturnType<typeof sender>["send"]) {
  return answerItem(item, "no", "Later.", null, { home, send, record: () => recordAnswer(item.id, "no", "Later.", home) });
}

async function agent(name: string, parent: string) {
  await mkdir(agentDir(name, home), { recursive: true });
  await writeFile(join(agentDir(name, home), "session.json"), JSON.stringify({ name, parent, cwd: "/gone", sessionId: "s", id: "i" }));
}

test("the answer is recorded even when delivery to the filer throws, and goes to its parent", async () => {
  const item = await addItem(base, home);
  await agent("comb-public-ready", "maya");
  const s = sender(["comb-public-ready"]);

  const r = await answer(item, s.send);
  expect((await readItem(item.id, home)).status).toBe("declined");
  expect(r.item.status).toBe("declined");
  expect(r.notice).toBe("Recorded. comb-public-ready couldn't be woken, so maya was told.");
  expect(s.sent.map((m) => m.name)).toEqual(["comb-public-ready", "maya"]);
  const relay = s.sent[1]!.message;
  expect(relay).toContain("Working directory does not exist");
  expect(relay).toContain(`Greg said not now to your decision "Make comb standalone"`);
});

test("the answer goes to the filer's own parent, not always maya", async () => {
  const item = await addItem(base, home);
  await agent("comb-public-ready", "comb-lead");
  const s = sender(["comb-public-ready"]);
  const r = await answer(item, s.send);
  expect(s.sent.map((m) => m.name)).toEqual(["comb-public-ready", "comb-lead"]);
  expect(r.notice).toContain("so comb-lead was told");
});

test("an answer that nobody can be woken for is still recorded, and says so", async () => {
  const item = await addItem(base, home);
  const s = sender(["comb-public-ready", "maya"]);
  const r = await answer(item, s.send);
  expect((await readItem(item.id, home)).status).toBe("declined");
  expect(r.notice).toContain("Recorded. comb-public-ready couldn't be woken");
  expect(r.notice).toContain("neither could maya");
});

test("a delivered answer has no notice and sends once", async () => {
  const item = await addItem(base, home);
  const s = sender([]);
  const r = await answer(item, s.send);
  expect(r).toMatchObject({ woke: true, notice: null });
  expect(s.sent).toHaveLength(1);
});

test("an answer sendToAgent already forwarded to the parent says so, and is not sent twice", async () => {
  const item = await addItem(base, home);
  const sent: string[] = [];
  const send = async (name: string) => {
    sent.push(name);
    return { woke: false, forwardedTo: "maya", reason: "Claude Code has not trusted /w" };
  };
  const r = await answer(item, send);
  expect(r).toMatchObject({ woke: false, notice: "Recorded. comb-public-ready couldn't be woken, so maya was told." });
  expect(sent).toEqual(["comb-public-ready"]);
});
