/**
 * TK-008: queue cards withdraw themselves when the work is done or taken
 * elsewhere, and a Not now on a pick stays. A fake hive home and a fake branch
 * reader stand in for ~/.hive and git; one test runs git on a temp repo it makes.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MemoryCandidate, MemoryWriter } from "../hive";
import { branchNames, gitBranches, runNightly, type Branch } from "../nightly";
import { splitQueue } from "../page/ui/cards";
import {
  addItem, listItems, parseItem, precedentEntry, readItem, recordAnswer, serializeItem, syncAllPrecedents, withdrawItem,
} from "../queue";

let root: string;
let home: string;
let hiveHome: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "comb-withdraw-"));
  home = join(root, "comb");
  hiveHome = join(root, "hive");
  await mkdir(home, { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const NOW = new Date(2026, 10, 22, 12, 0, 0);
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3600_000);
const iso = (d: Date) => d.toISOString();

async function ticket(project: string, id: string, status: string, updated?: Date) {
  const dir = join(hiveHome, "projects", project, "tickets");
  await mkdir(dir, { recursive: true });
  await writeFile(join(hiveHome, "projects", project, "config.md"), `path: /repos/${project}\n`);
  await writeFile(join(dir, `${id}.md`), `---\nid: ${id}\ntitle: ${id} title\nstatus: ${status}\n${updated ? `updated: ${iso(updated)}\n` : ""}---\n\nBody.\n`);
}

/** A card in the shape hive's pick files (isPick). */
const pick = (project: string, id: string, created: Date) =>
  addItem({ kind: "proposal", from: "maya", title: `Start ${project} ${id}: ${id} title`, action: `Maya starts task agent ${project}-${id.toLowerCase()} on ${project} ${id}.`, project, ticket: id }, home, created);

/** A fake git: branches per repo path, and which repos were read. */
function fakeGit(map: Record<string, Branch[]> = {}) {
  const read: string[] = [];
  return { read, branches: (repo: string) => { read.push(repo); return map[repo] ?? []; } };
}

const sweep = (o: { dryRun?: boolean; branches?: (repo: string) => Branch[] } = {}) =>
  runNightly({ home, hiveHome, now: NOW, asks: false, dryRun: o.dryRun, branches: o.branches ?? fakeGit().branches });

const status = async (id: string) => (await readItem(id, home)).status;

// --- the status ---------------------------------------------------------------

test("withdrawItem records who and why, writes no precedent, and refuses answered items and empty reasons", async () => {
  const a = await pick("acme-api", "TK-1", hoursAgo(5));
  const w = await withdrawItem(a.id, "  TK-1 was built\n in Greg's session ", "maya", home, NOW);
  expect(w).toMatchObject({ status: "withdrawn", withdrawn: iso(NOW), withdrawnBy: "maya", withdrawnWhy: "TK-1 was built in Greg's session", answered: null, note: null });
  expect(await readItem(a.id, home)).toMatchObject({ status: "withdrawn", withdrawnWhy: "TK-1 was built in Greg's session" });
  expect(existsSync(join(home, "precedents"))).toBe(false);
  await expect(withdrawItem(a.id, "again", "maya", home)).rejects.toThrow(/Already withdrawn: TK-1 was built/);

  const b = await pick("acme-api", "TK-2", hoursAgo(5));
  await expect(withdrawItem(b.id, "   ", "maya", home)).rejects.toThrow(/Give the reason/);
  await recordAnswer(b.id, "no", "later", home, NOW);
  await expect(withdrawItem(b.id, "stale", "maya", home)).rejects.toThrow(/already answered it \(declined\)/);
  await expect(withdrawItem("no-such-item", "stale", "maya", home)).rejects.toThrow(/No such queue item/);
});

test("a withdrawn item lists for a day by its withdrawal time, and the page splits it from the answers", async () => {
  const a = await pick("acme-api", "TK-1", hoursAgo(72));
  const b = await pick("acme-api", "TK-2", hoursAgo(72));
  const c = await pick("acme-api", "TK-3", hoursAgo(72));
  await withdrawItem(a.id, "done", "sweep", home, hoursAgo(1));
  await withdrawItem(b.id, "done", "sweep", home, hoursAgo(30));
  await recordAnswer(c.id, "go", null, home, hoursAgo(2));
  const list = await listItems(home, 24 * 3600_000, NOW.getTime());
  expect(list.map((i) => i.id).sort()).toEqual([a.id, c.id].sort());
  const { open, answered, withdrawn } = splitQueue(list);
  expect(open).toEqual([]);
  expect(answered.map((i) => i.id)).toEqual([c.id]);
  expect(withdrawn.map((i) => i.id)).toEqual([a.id]);
});

test("the page shows a withdrawn item for 24 hours after its withdrawal, then not at all; the file stays", async () => {
  const a = await pick("acme-api", "TK-1", hoursAgo(200));
  await withdrawItem(a.id, "TK-1 is closed", "sweep", home, NOW);
  const shown = (h: number) => listItems(home, 24 * 3600_000, NOW.getTime() + h * 3600_000).then((l) => l.map((i) => i.id));
  expect(await shown(23)).toEqual([a.id]);
  expect(await shown(25)).toEqual([]);
  expect(await readItem(a.id, home)).toMatchObject({ status: "withdrawn", withdrawnWhy: "TK-1 is closed" });
});

test("an item.md from before TK-008 still parses, and a withdrawn one round-trips", async () => {
  const old = "---\nid: 2026-11-15-x\nkind: proposal\nfrom: maya\ntitle: Start x\naction: Do x.\nproject: p\nticket: TK-1\nstatus: declined\ncreated: 2026-11-15T08:00:00.000Z\nanswered: 2026-11-15T09:00:00.000Z\nnote: Not now\n---\n\nThe case.\n";
  expect(parseItem(old)).toMatchObject({ status: "declined", withdrawn: null, withdrawnBy: null, withdrawnWhy: null, note: "Not now", body: "The case." });
  const a = await pick("acme-api", "TK-1", hoursAgo(5));
  const w = await withdrawItem(a.id, "TK-1 is closed", "sweep", home, NOW);
  expect(parseItem(serializeItem(w))).toEqual(w);
  // An unknown status still reads as open, as before.
  expect(parseItem(old.replace("status: declined", "status: someday")).status).toBe("open");
});

test("Greg's answer that races the sweep still counts and clears the withdrawal", async () => {
  const a = await pick("acme-api", "TK-1", hoursAgo(5));
  await withdrawItem(a.id, "TK-1 is closed", "sweep", home, hoursAgo(1));
  const done = await recordAnswer(a.id, "go", null, home, NOW);
  expect(done).toMatchObject({ status: "approved", withdrawn: null, withdrawnBy: null, withdrawnWhy: null });
  expect(existsSync(join(home, "precedents", `${a.id}.md`))).toBe(true);
});

// --- never a precedent --------------------------------------------------------

test("withdrawn never reaches hive: no precedent file, no entry, and the backfill sends nothing", async () => {
  const writes: MemoryCandidate[] = [];
  const writer: MemoryWriter = { writeMemory: (c) => { writes.push(c); return Promise.resolve("ok"); } };
  await ticket("acme-api", "TK-1", "closed", hoursAgo(1));
  const a = await pick("acme-api", "TK-1", hoursAgo(5));
  const b = await pick("acme-api", "TK-2", hoursAgo(5));
  // One by the sweep, one by an agent.
  expect((await sweep()).withdrawn.map((l) => l.id)).toEqual([a.id]);
  await withdrawItem(b.id, "built elsewhere", "maya", home, NOW);
  expect(existsSync(join(home, "precedents"))).toBe(false);
  const wa = await readItem(a.id, home);
  expect(wa.status).toBe("withdrawn");
  expect(() => precedentEntry(wa)).toThrow(/not answered/);

  // Even with a stray precedent file beside it, the backfill refuses to build an entry from a withdrawn item.
  await mkdir(join(home, "precedents"), { recursive: true });
  await writeFile(join(home, "precedents", `${b.id}.md`), "# stray\n");
  const r = await syncAllPrecedents({ writer, projects: ["acme-api"] }, { home });
  expect(writes).toEqual([]);
  expect(r.synced).toEqual([]);
  expect(r.skipped).toEqual([{ id: b.id, why: "the item is still open" }]);
});

// --- the sweep's rules --------------------------------------------------------

test("rule 1: a closed or done ticket withdraws its pick, and any card filed before the close", async () => {
  await ticket("acme-api", "TK-1", "closed", hoursAgo(1));
  await ticket("acme-api", "TK-2", "done"); // no updated time: a pick still goes
  await ticket("hive", "TK-158", "closed", hoursAgo(1));
  await ticket("hive", "TK-160", "closed", hoursAgo(10));
  const p1 = await pick("acme-api", "TK-1", hoursAgo(48));
  const p2 = await pick("acme-api", "TK-2", hoursAgo(48));
  // A decision filed before its ticket closed (hive TK-158 on 2026-11-22) goes.
  const before = await addItem({ kind: "decision", from: "maya", title: "Raise the limit?", action: "Raise it.", project: "hive", ticket: "TK-158" }, home, hoursAgo(48));
  // A review filed after its ticket closed is the ask that is left: it stays.
  const after = await addItem({ kind: "review", from: "hive-tk-160", title: "Review: merge TK-160", action: "Merge it.", project: "hive", ticket: "TK-160" }, home, hoursAgo(5));
  const r = await sweep();
  expect(Object.fromEntries(r.withdrawn.map((l) => [l.id, l.reason]))).toEqual({
    [p1.id]: "TK-1 is closed",
    [p2.id]: "TK-2 is done",
    [before.id]: "TK-158 is closed",
  });
  expect(await status(after.id)).toBe("open");
  expect(await readItem(p1.id, home)).toMatchObject({ status: "withdrawn", withdrawnBy: "sweep", withdrawnWhy: "TK-1 is closed", withdrawn: iso(NOW) });
});

test("rule 2: an in_progress ticket withdraws its pick, not another agent's card, and is not filed again", async () => {
  await ticket("contentdash", "TK-002", "in_progress", hoursAgo(1));
  const p = await pick("contentdash", "TK-002", hoursAgo(60));
  const review = await addItem({ kind: "review", from: "contentdash-tk-002", title: "Review step 2", action: "Merge it.", project: "contentdash", ticket: "TK-002" }, home, hoursAgo(2));
  // A card from Maya that is not a pick (another action) is not a pick either.
  const other = await addItem({ kind: "proposal", from: "maya", title: "Split TK-002", action: "Maya splits TK-002 in two.", project: "contentdash", ticket: "TK-002" }, home, hoursAgo(60));
  const r = await sweep();
  expect(r.withdrawn).toEqual([{ label: "contentdash TK-002", title: p.title, reason: "TK-002 is in_progress: someone has the work", id: p.id }]);
  expect(await status(review.id)).toBe("open");
  expect(await status(other.id)).toBe("open");

  // hive picks an in_progress ticket: it is skipped at filing, not filed and withdrawn an hour later.
  await ticket("dobby", "TK-059", "in_progress");
  await mkdir(hiveHome, { recursive: true });
  await writeFile(join(hiveHome, "next.json"), JSON.stringify({ version: 2, selections: [{ disposition: "recommended", sourceWatch: "dobby/act", projectId: "dobby", ticketId: "TK-059", selectedAt: iso(hoursAgo(1)), rationale: "Why." }] }));
  const n = await sweep();
  expect(n.filed).toEqual([]);
  expect(n.skipped).toContainEqual({ label: "dobby TK-059", reason: "ticket is in_progress: someone has the work" });
});

test("rule 3: Greg's Not now on a pick holds until the ticket changes, with no 7-day expiry", async () => {
  await ticket("matreas", "TK-479", "open", new Date(2026, 9, 15));
  const first = await pick("matreas", "TK-479", new Date(2026, 10, 15, 8));
  await recordAnswer(first.id, "no", "Not focused on this", home, new Date(2026, 10, 15, 17));
  const again = await pick("matreas", "TK-479", new Date(2026, 10, 22, 9));
  const r = await sweep();
  expect(r.withdrawn.map((l) => [l.id, l.reason])).toEqual([[again.id, `Greg said Not now on ${iso(new Date(2026, 10, 15, 17)).slice(0, 10)} (${first.id}), and the ticket has not changed since`]]);
  // The Not now itself is untouched.
  expect(await readItem(first.id, home)).toMatchObject({ status: "declined", note: "Not focused on this" });

  // Once the ticket changes after the Not now, a new card stays.
  await ticket("matreas", "TK-479", "open", hoursAgo(3));
  const third = await pick("matreas", "TK-479", hoursAgo(1));
  expect((await sweep()).withdrawn).toEqual([]);
  expect(await status(third.id)).toBe("open");
});

test("rule 3 counts only a Not now on a pick, given before the card", async () => {
  await ticket("matreas", "TK-480", "open");
  // A declined decision about the same ticket is not a Not now on the pick.
  const d = await addItem({ kind: "decision", from: "maya", title: "Drop TK-480?", action: "Close it.", project: "matreas", ticket: "TK-480" }, home, hoursAgo(50));
  await recordAnswer(d.id, "no", null, home, hoursAgo(49));
  const p = await pick("matreas", "TK-480", hoursAgo(10));
  expect((await sweep()).withdrawn).toEqual([]);
  expect(await status(p.id)).toBe("open");
});

test("rule 4: a branch that names the ticket with commits newer than the card withdraws the pick", async () => {
  await ticket("seodash", "TK-033", "open");
  await ticket("seodash", "TK-034", "open");
  await ticket("seodash", "TK-035", "open");
  const p33 = await pick("seodash", "TK-033", hoursAgo(48));
  const p34 = await pick("seodash", "TK-034", hoursAgo(48));
  const p35 = await pick("seodash", "TK-035", hoursAgo(48));
  const git = fakeGit({
    "/repos/seodash": [
      { name: "worktree-seodash-tk-033", at: iso(hoursAgo(3)) },
      { name: "origin/tk033-quota", at: iso(hoursAgo(1)) },
      { name: "tk-034-old", at: iso(hoursAgo(72)) }, // older than the card: stays
      { name: "tk-0350-other", at: iso(hoursAgo(1)) }, // another ticket: stays
      { name: "main", at: iso(hoursAgo(1)) },
    ],
  });
  const r = await sweep({ branches: git.branches });
  expect(r.withdrawn.map((l) => [l.id, l.reason])).toEqual([[p33.id, `branch origin/tk033-quota has commits since the card (${iso(hoursAgo(1)).slice(0, 10)})`]]);
  expect(await status(p34.id)).toBe("open");
  expect(await status(p35.id)).toBe("open");
  // One read per repo, however many cards it has.
  expect(git.read).toEqual(["/repos/seodash"]);
});

test("a dry run lists what it would withdraw and writes nothing", async () => {
  await ticket("acme-api", "TK-1", "closed", hoursAgo(1));
  await ticket("acme-api", "TK-2", "open");
  const a = await pick("acme-api", "TK-1", hoursAgo(5));
  const b = await pick("acme-api", "TK-2", hoursAgo(5));
  const files = () => Promise.all(readdirSync(join(home, "queue")).map((d) => readFile(join(home, "queue", d, "item.md"), "utf-8")));
  const before = await files();
  const r = await sweep({ dryRun: true });
  expect(r.withdrawn).toEqual([{ label: "acme-api TK-1", title: a.title, reason: "TK-1 is closed", id: a.id }]);
  expect(await files()).toEqual(before);
  expect(await status(b.id)).toBe("open");
  expect(existsSync(join(home, "nightly"))).toBe(false);
});

test("cards without a project, a ticket or a hive ticket file are left alone", async () => {
  const loose = await addItem({ kind: "decision", from: "comb-public-ready", title: "Make comb standalone", action: "Do it." }, home, hoursAgo(5));
  const missing = await pick("ghost", "TK-9", hoursAgo(5));
  expect((await sweep()).withdrawn).toEqual([]);
  expect(await status(loose.id)).toBe("open");
  expect(await status(missing.id)).toBe("open");
});

// --- the branch check ---------------------------------------------------------

test("branchNames matches the ticket id with or without its dash, and not a longer number", () => {
  expect(branchNames("worktree-contentdash-tk-002", "TK-002")).toBe(true);
  expect(branchNames("TK002-carousels", "TK-002")).toBe(true);
  expect(branchNames("origin/fix/tk-2", "TK-2")).toBe(true);
  expect(branchNames("tk-0021", "TK-002")).toBe(false);
  expect(branchNames("atk-002", "TK-002")).toBe(false);
  expect(branchNames("step-2-carousels", "TK-002")).toBe(false);
  expect(branchNames("anything", "not a ticket")).toBe(false);
});

test("gitBranches reads local branches and their tip times from a real repo, and a non-repo as none", async () => {
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { stdio: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "one");
  git("branch", "worktree-acme-api-tk-7");
  const got = gitBranches(repo);
  expect(got.map((b) => b.name).sort()).toEqual(["main", "worktree-acme-api-tk-7"]);
  expect(got.every((b) => Number.isFinite(Date.parse(b.at)))).toBe(true);
  expect(gitBranches(join(root, "not-a-repo"))).toEqual([]);
});
