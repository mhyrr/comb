import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseAttention, readActPicks } from "../hive";
import { askSubject, formatNightly, localDate, runNightly, stateFile } from "../nightly";
import { addItem, listItems, recordAnswer } from "../queue";

let home: string;
let hiveHome: string;
beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "comb-nightly-"));
  home = join(root, "comb");
  hiveHome = join(root, "hive");
  await mkdir(home, { recursive: true });
});
afterEach(async () => { await rm(join(home, ".."), { recursive: true, force: true }); });

// Midday local time, so the local date is the same in any time zone the tests run in.
const NOW = new Date(2026, 10, 13, 12, 0, 0);
const TODAY = localDate(NOW);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3600_000).toISOString();

async function ticket(project: string, id: string, status = "open", title = `${project} ${id} title`) {
  const dir = join(hiveHome, "projects", project, "tickets");
  await mkdir(dir, { recursive: true });
  await writeFile(join(hiveHome, "projects", project, "config.md"), `path: /tmp/${project}\n`);
  await writeFile(join(dir, `${id}.md`), `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\ntype: bug\npriority: 2\n---\n\nBody.\n`);
}

type Sel = { projectId: string; ticketId: string; selectedAt: string; rationale?: string; disposition?: string };
async function picks(selections: Sel[]) {
  await mkdir(hiveHome, { recursive: true });
  const full = selections.map((s) => ({ disposition: "recommended", sourceWatch: `${s.projectId}/act`, rationale: `Why ${s.ticketId}.`, ...s }));
  await writeFile(join(hiveHome, "next.json"), JSON.stringify({ version: 2, selections: full }));
}

async function briefing(date: string, asks: string[]) {
  await mkdir(join(hiveHome, "briefings"), { recursive: true });
  const list = asks.map((a, i) => `${i + 1}. ${a}`).join("\n");
  await writeFile(join(hiveHome, "briefings", `${date}.md`), `# HIVE — ${date}\n\n## Headline\nStuff.\n\n## What needs your attention\n${list}\n\n## Memory + verifier\n- Added: 9.\n`);
}

/** Today's real shape: fresh picks, stale picks, a closed ticket, a missing one, and asks. */
async function tonight() {
  await ticket("arete", "TK-042", "open", "Print always uses the light colours");
  await ticket("dobby", "TK-042");
  await ticket("seodash", "TK-038", "open", "Add `seodash traffic`");
  await ticket("hive", "TK-120", "closed");
  await ticket("revrec", "TK-153", "done");
  await picks([
    { projectId: "arete", ticketId: "TK-042", selectedAt: daysAgo(0.2) },
    { projectId: "dobby", ticketId: "TK-042", selectedAt: daysAgo(23) },
    { projectId: "seodash", ticketId: "TK-038", selectedAt: daysAgo(0.1) },
    { projectId: "hive", ticketId: "TK-120", selectedAt: daysAgo(0.2) },
    { projectId: "revrec", ticketId: "TK-153", selectedAt: daysAgo(0.5) },
    { projectId: "matreas", ticketId: "TK-479", selectedAt: daysAgo(0.2) },
    { projectId: "cohere", ticketId: "TK-010", selectedAt: daysAgo(1), disposition: "rejected" },
  ]);
  await briefing(TODAY, [
    "**Arete:** give the collaborator the Cooking L1–L5 conversion.",
    "**hive:** decide where `attach` lives: keep it in hive,\n   or move it to comb.",
    "**seodash TK-038:** building it unblocks the collegevalue baseline.",
  ]);
}

test("fresh picks become proposals from Maya, asks become decisions, and the rest is skipped with a reason", async () => {
  await tonight();
  const r = await runNightly({ home, hiveHome, now: NOW });
  expect(r.filed.map((f) => f.label)).toEqual(["ask 1", "ask 2", "seodash TK-038", "arete TK-042"]);
  expect(Object.fromEntries(r.skipped.map((s) => [s.label, s.reason]))).toEqual({
    "dobby TK-042": "stale: picked 2026-10-21, 23 days ago",
    "hive TK-120": "ticket is closed",
    "revrec TK-153": "ticket is done",
    "matreas TK-479": "hive has no ticket matreas/TK-479",
    "ask 3": "covered by hive's pick seodash TK-038",
  });

  const items = await listItems(home, 0, NOW.getTime());
  const pick = items.find((i) => i.ticket === "TK-042")!;
  expect(pick).toMatchObject({
    kind: "proposal",
    from: "maya",
    project: "arete",
    title: "Start arete TK-042: Print always uses the light colours",
    action: "Maya starts task agent arete-tk-042 on arete TK-042.",
  });
  expect(pick.body).toContain("## hive's rationale\n\nWhy TK-042.");
  const ask = items.find((i) => i.title.startsWith("hive:"))!;
  expect(ask).toMatchObject({ kind: "decision", from: "maya", project: "hive", ticket: null, title: "hive: decide where `attach` lives: keep it in hive, or move it to comb." });
  expect(ask.body).toContain(`From hive's briefing for ${TODAY}`);
});

test("a second run files nothing: each pick and ask is recorded once", async () => {
  await tonight();
  await runNightly({ home, hiveHome, now: NOW });
  const again = await runNightly({ home, hiveHome, now: new Date(NOW.getTime() + 3600_000) });
  expect(again.filed).toEqual([]);
  expect(again.skipped.filter((s) => s.reason!.startsWith("already filed")).map((s) => s.label)).toEqual(["seodash TK-038", "arete TK-042", "ask 1", "ask 2"]);
  const items = await listItems(home, 0, NOW.getTime());
  expect(items.length).toBe(4);
  expect(Object.keys(JSON.parse(await readFile(stateFile(home), "utf-8")).filed)).toContain(`pick:arete:TK-042:${daysAgo(0.2)}`);

  // Once Greg answers, the item is no longer open, and it is still not refiled.
  for (const i of items) await recordAnswer(i.id, "no", null, home);
  const after = await runNightly({ home, hiveHome, now: new Date(NOW.getTime() + 2 * 3600_000) });
  expect(after.filed).toEqual([]);
});

test("an open queue item on the same ticket blocks a pick; the same id in another project does not", async () => {
  await ticket("arete", "TK-042");
  await ticket("dobby", "TK-042");
  await ticket("revrec", "TK-153");
  await picks([
    { projectId: "arete", ticketId: "TK-042", selectedAt: daysAgo(0.1) },
    { projectId: "dobby", ticketId: "TK-042", selectedAt: daysAgo(0.1) },
    { projectId: "revrec", ticketId: "TK-153", selectedAt: daysAgo(0.1) },
  ]);
  await addItem({ kind: "proposal", from: "maya", title: "Fix the dark print (TK-042)", action: "x", project: "arete" }, home);
  await addItem({ kind: "proposal", from: "maya", title: "Admin PDF download", action: "x", project: "revrec", ticket: "TK-153" }, home);
  const r = await runNightly({ home, hiveHome, now: NOW });
  expect(r.filed.map((f) => f.label)).toEqual(["dobby TK-042"]);
  expect(r.skipped.map((s) => s.reason)).toEqual([
    expect.stringMatching(/^already open in the queue: .*fix-the-dark-print/),
    expect.stringMatching(/^already open in the queue: .*admin-pdf-download/),
  ]);
});

test("the cap gives asks the room; excess picks wait for tomorrow, excess asks drop", async () => {
  for (const p of ["a", "b", "c"]) await ticket(p, "TK-001");
  await picks(["a", "b", "c"].map((p, i) => ({ projectId: p, ticketId: "TK-001", selectedAt: daysAgo(0.1 * (i + 1)) })));
  await briefing(TODAY, ["One.", "Two.", "Three."]);
  const r = await runNightly({ home, hiveHome, now: NOW, maxItems: 4 });
  expect(r.filed.map((f) => f.label)).toEqual(["ask 1", "ask 2", "ask 3", "a TK-001"]);
  expect(r.deferred.map((d) => d.label)).toEqual(["b TK-001", "c TK-001"]);
  expect(r.deferred[0]!.reason).toContain("refiled tomorrow");

  // Later the same night: the cap still holds.
  const later = await runNightly({ home, hiveHome, now: new Date(NOW.getTime() + 3600_000), maxItems: 4 });
  expect(later.filed).toEqual([]);
  expect(later.deferred.map((d) => d.label)).toEqual(["b TK-001", "c TK-001"]);

  // The next night the deferred picks are filed; yesterday's asks are not reread.
  const tomorrow = await runNightly({ home, hiveHome, now: new Date(NOW.getTime() + 24 * 3600_000), maxItems: 4 });
  expect(tomorrow.filed.map((f) => f.label)).toEqual(["b TK-001", "c TK-001"]);
  expect(tomorrow.briefing).toContain("no briefing for");
});

test("one pick per project a night: a second pick for the same project waits", async () => {
  await ticket("arete", "TK-042");
  await ticket("arete", "TK-043");
  await picks([{ projectId: "arete", ticketId: "TK-042", selectedAt: daysAgo(0.3) }]);
  await runNightly({ home, hiveHome, now: NOW });
  await picks([{ projectId: "arete", ticketId: "TK-043", selectedAt: daysAgo(0.01) }]);
  const r = await runNightly({ home, hiveHome, now: NOW });
  expect(r.filed).toEqual([]);
  expect(r.skipped[0]).toMatchObject({ label: "arete TK-043", reason: expect.stringContaining("one pick per project") });
  const next = await runNightly({ home, hiveHome, now: new Date(NOW.getTime() + 24 * 3600_000) });
  expect(next.filed.map((f) => f.label)).toEqual(["arete TK-043"]);
});

test("a dry run reports and writes nothing", async () => {
  await tonight();
  const r = await runNightly({ home, hiveHome, now: NOW, dryRun: true });
  expect(r.filed.length).toBe(4);
  expect(existsSync(join(home, "queue"))).toBe(false);
  expect(existsSync(stateFile(home))).toBe(false);
  expect(formatNightly(r)).toContain("Would file:");
});

test("no hive output yet means nothing to file, not an error", async () => {
  const r = await runNightly({ home, hiveHome, now: NOW });
  expect(r.filed).toEqual([]);
  expect(formatNightly(r)).toContain("Nothing new.");
});

test("hive readers: a half-written next.json reads as no picks; the attention list stops at the next heading", async () => {
  await mkdir(hiveHome, { recursive: true });
  await writeFile(join(hiveHome, "next.json"), '{"version": 2, "selections": [');
  expect(readActPicks(hiveHome)).toEqual([]);
  const text = "## What needs your attention\n1. **A:** one\n   continued.\n2. two\n\n## Memory\n1. not an ask\n";
  expect(parseAttention(text)).toEqual(["**A:** one continued.", "two"]);
  expect(parseAttention("# no list here")).toEqual([]);
});

test("an ask names its project from the bold lead and its ticket from anywhere", () => {
  const projects = ["revrec", "hive", "seodash"];
  expect(askSubject("**revrec staging v163.** Load it yourself.", projects)).toEqual({ project: "revrec", ticket: null });
  expect(askSubject("**Merge hive PR #41** and unload it.", projects)).toEqual({ project: "hive", ticket: null });
  expect(askSubject("**revrec:** schedule the A/B for TK-150.", projects)).toEqual({ project: "revrec", ticket: "TK-150" });
  expect(askSubject("**Candidate A.** Let Maya measure it.", projects)).toEqual({ project: null, ticket: null });
});
