/**
 * Precedents in hive memory (TK-001, D13). A fake hive writer stands in for
 * the hive MCP server, so nothing here touches the real ~/.hive.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MemoryCandidate, MemoryWriter } from "../hive";
import { addItem, formatSyncReport, precedentEntry, readItem, recordAnswer, syncAllPrecedents, type PrecedentSink } from "../queue";

// The entry's day is Greg's local day; pin the zone so the test reads the same anywhere.
process.env.TZ = "America/Chicago";

let home: string;
let quiet: ReturnType<typeof spyOn>;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "comb-precedents-"));
  quiet = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  quiet.mockRestore();
  await rm(home, { recursive: true, force: true });
});

/** A fake hive: records each write, or fails the way it is told to. */
function fakeHive(fail: ((c: MemoryCandidate) => Error | "hang" | null) = () => null) {
  const writes: MemoryCandidate[] = [];
  const writer: MemoryWriter = {
    writeMemory: (c) => {
      const f = fail(c);
      if (f === "hang") return new Promise<string>(() => {});
      if (f) return Promise.reject(f);
      writes.push(c);
      return Promise.resolve(`Queued decision directive for ${c.project}.`);
    },
  };
  const sink = (projects = ["acme-api", "comb"]): PrecedentSink => ({ writer, projects, timeoutMs: 50 });
  return { writes, sink };
}

const base = { kind: "proposal", from: "maya", title: "Start acme-api on TK-143", action: "Start acme-api on TK-143 and triage the Sobelow findings.", changes: "Nothing visible: the Sobelow findings get triaged.", project: "acme-api", ticket: "TK-143" };
const at = new Date("2026-11-18T12:00:00Z");
const precedent = (id: string) => readFile(join(home, "precedents", `${id}.md`), "utf-8");

test("a Not now writes the precedent and one hive decision with the title, the action, the answer and the reason", async () => {
  const hive = fakeHive();
  const item = await addItem(base, home);
  const done = await recordAnswer(item.id, "no", "Not before the readout.", home, at, null, hive.sink());
  expect(hive.writes).toEqual([{
    project: "acme-api",
    type: "decision",
    content: `Greg declined maya's proposal "Start acme-api on TK-143" (acme-api TK-143) on 2026-11-18: not now. Proposed: Start acme-api on TK-143 and triage the Sobelow findings. Reason: Not before the readout.`,
    tags: ["precedent", "queue"],
    provenanceNote: `Greg's answer on comb's page to queue item ${item.id}, filed by maya. From comb's precedents/${item.id}.md.`,
    directive: true,
  }]);
  expect(done.hiveSync).toBe("queued acme-api 2026-11-18T12:00:00.000Z");
  expect((await readItem(item.id, home)).hiveSync).toBe("queued acme-api 2026-11-18T12:00:00.000Z");
  const text = await precedent(item.id);
  expect(text).toContain("- Why: Not before the readout.\n");
  expect(text).toEndWith("- Hive memory: queued as a decision in acme-api at 2026-11-18T12:00:00.000Z\n");
});

test("a Go names Greg's model; a Redirect says what to do instead; no reason says so", async () => {
  const hive = fakeHive();
  const a = await addItem({ ...base, model: "opus" }, home);
  await recordAnswer(a.id, "go", null, home, at, "fable", hive.sink());
  const b = await addItem({ ...base, title: "Second" }, home);
  await recordAnswer(b.id, "redirect", "Do the dependabot batch first.", home, at, null, hive.sink());
  const c = await addItem({ ...base, kind: "decision", title: "Third" }, home);
  await recordAnswer(c.id, "go", null, home, at, null, hive.sink());
  const [go, redirect, plain] = hive.writes.map((w) => w.content);
  expect(go).toContain("on 2026-11-18: go (model: fable). Proposed:");
  expect(go).toEndWith("No reason given.");
  expect(redirect).toStartWith(`Greg redirected maya's proposal "Second"`);
  expect(redirect).toEndWith(": redirect. Proposed: Start acme-api on TK-143 and triage the Sobelow findings. Do this instead: Do the dependabot batch first.");
  expect(plain).toContain("decision \"Third\" (acme-api TK-143) on 2026-11-18: go. Proposed:");
});

test("an item with no project, or one hive does not register, is scoped to comb", async () => {
  const hive = fakeHive();
  const a = await addItem({ ...base, project: null, ticket: null }, home);
  await recordAnswer(a.id, "no", null, home, at, null, hive.sink());
  const b = await addItem({ ...base, title: "Elsewhere", project: "not-in-hive" }, home);
  await recordAnswer(b.id, "no", null, home, at, null, hive.sink());
  expect(hive.writes.map((w) => w.project)).toEqual(["comb", "comb"]);
  // The entry still names the item's own project, so a search for it finds the call.
  expect(hive.writes[1]!.content).toContain("(not-in-hive TK-143)");
});

test("a hive failure never fails the answer: it is logged, and the item and precedent say not synced", async () => {
  const hive = fakeHive(() => new Error("Could not start the hive MCP server: spawn hive ENOENT"));
  const item = await addItem(base, home);
  const done = await recordAnswer(item.id, "no", "Later.", home, at, null, hive.sink());
  expect(done.status).toBe("declined");
  expect(done.hiveSync).toBe("not synced: Could not start the hive MCP server: spawn hive ENOENT");
  expect((await readItem(item.id, home)).hiveSync).toBe(done.hiveSync);
  expect(await precedent(item.id)).toContain(
    "- Hive memory: not synced at 2026-11-18T12:00:00.000Z (Could not start the hive MCP server: spawn hive ENOENT). Retry: comb precedents sync\n");
  expect(quiet).toHaveBeenCalledWith(`comb: precedent ${item.id} was not synced to hive memory: Could not start the hive MCP server: spawn hive ENOENT`);
});

test("a hive that never answers times out as a failed sync instead of holding the answer", async () => {
  const hive = fakeHive(() => "hang");
  const item = await addItem(base, home);
  const done = await recordAnswer(item.id, "go", null, home, at, null, hive.sink());
  expect(done).toMatchObject({ status: "approved", hiveSync: "not synced: hive did not answer in time" });
});

test("without hive (D24) the precedent stays local, with no sync line", async () => {
  const item = await addItem(base, home);
  const done = await recordAnswer(item.id, "no", null, home, at);
  expect(done.hiveSync).toBeNull();
  expect(await precedent(item.id)).not.toContain("Hive memory");
});

test("an entry fits hive's 1000-character cap and never holds a ## header", async () => {
  const item = await addItem({ ...base, title: "## Sneaky header", action: "x".repeat(2000) }, home);
  const done = await recordAnswer(item.id, "no", `Because ## reasons. ${"y".repeat(300)}`, home, at);
  const entry = precedentEntry(done);
  expect(entry.length).toBeLessThanOrEqual(1000);
  expect(entry).not.toContain("## ");
  expect(entry).toContain(`Reason: Because # reasons. ${"y".repeat(300)}`);
  expect(entry).toContain("Proposed: xxx");
  expect(entry).toContain("…");
});

test("the backfill sends each precedent once, retries failures, and a dry run writes nothing", async () => {
  // Three answers given while hive was off, so none is in hive memory yet.
  const ids: string[] = [];
  for (const title of ["One", "Two", "Three"]) {
    const item = await addItem({ ...base, title }, home);
    await recordAnswer(item.id, "no", `${title} later.`, home, at);
    ids.push(item.id);
  }
  await addItem({ ...base, title: "Still open" }, home);

  const dry = fakeHive();
  const plan = await syncAllPrecedents(dry.sink(), { home, dryRun: true });
  expect(dry.writes).toEqual([]);
  expect(plan.planned.map((p) => p.id)).toEqual([...ids].sort());
  expect(await precedent(ids[0]!)).not.toContain("Hive memory");
  expect(formatSyncReport(plan, true)).toStartWith("Would queue 3 precedent(s) in hive memory:\n");

  // First run: hive refuses "Two".
  const flaky = fakeHive((c) => (c.content.includes('"Two"') ? new Error("hive is busy") : null));
  const first = await syncAllPrecedents(flaky.sink(), { home, now: at });
  expect(first.synced.length).toBe(2);
  expect(first.failed).toEqual([{ id: ids[1]!, error: "hive is busy" }]);
  expect(formatSyncReport(first, false)).toContain("Not synced: 1. Run it again to retry.");

  // Second run: only the failed one goes.
  const ok = fakeHive();
  const second = await syncAllPrecedents(ok.sink(), { home, now: at });
  expect(ok.writes.map((w) => w.content)).toEqual([expect.stringContaining('"Two"')]);
  expect(second).toMatchObject({ synced: [ids[1]], already: [ids[0], ids[2]].sort(), failed: [] });
  expect(await precedent(ids[1]!)).not.toContain("not synced");

  // Third run: nothing left.
  const idle = fakeHive();
  const third = await syncAllPrecedents(idle.sink(), { home, now: at });
  expect(idle.writes).toEqual([]);
  expect(third.already.length).toBe(3);
});
