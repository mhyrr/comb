import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readNightlyRun } from "../hive";
import { formatMorning, localDate, morningFile, runMorning } from "../nightly";

let root: string;
let home: string;
let hiveHome: string;
let sent: string[];
const notify = async (m: string) => { sent.push(m); };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "comb-morning-"));
  home = join(root, "comb");
  hiveHome = join(root, "hive");
  await mkdir(join(hiveHome, "logs"), { recursive: true });
  sent = [];
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

// Local times, so the local date holds in any time zone.
const at = (h: number, m = 0) => new Date(2026, 10, 25, h, m, 0);
const TODAY = localDate(at(9));

/** What ~/.hive/scripts/nightly.sh writes: a start line, then complete (with the stamp) or FAILED. */
async function nightly(date: string, end: "complete" | "failed" | "timeout" | "running", time = "02:00:05") {
  const lines = [`=== HIVE nightly: ${date} ${time} ===`, "power: 'AC Power'", "[STARTING] B.comb"];
  if (end === "failed") lines.push("[FAILED  ] V — error", "=== HIVE nightly FAILED (rc=1) at 02:10:00 ===");
  if (end === "timeout") lines.push("=== HIVE nightly TIMED OUT after 60m (rc=124) at 03:00:05 ===");
  if (end === "complete") {
    lines.push(`Briefing → ${join(hiveHome, "briefings", `${date}.md`)}`, "=== HIVE nightly complete: 02:07:46 ===");
    await mkdir(join(hiveHome, "memory", "runs", date), { recursive: true });
    await writeFile(join(hiveHome, "memory", "runs", date, ".complete"), "");
    await mkdir(join(hiveHome, "briefings"), { recursive: true });
    await writeFile(join(hiveHome, "briefings", `${date}.md`), `# HIVE — ${date}\n`);
  }
  await appendFile(join(hiveHome, "logs", "nightly.log"), lines.join("\n") + "\n");
}

test("silent while today's nightly has not run, or is still running; yesterday's run does not count", async () => {
  await nightly("2026-11-24", "complete");
  let r = await runMorning({ home, hiveHome, now: at(1), notify });
  expect([r.run, r.message, sent]).toEqual(["none", null, []]);
  await nightly(TODAY, "running");
  r = await runMorning({ home, hiveHome, now: at(2, 3), notify });
  expect([r.run, r.message, sent]).toEqual(["running", null, []]);
  expect(r.outcome).toBe(`silent: hive's nightly for ${TODAY} is still running`);
  expect(existsSync(morningFile(home))).toBe(false);
});

test("after a completed nightly it wakes maya once with the briefing's path; the hourly runs after stay quiet", async () => {
  await nightly(TODAY, "complete");
  const r = await runMorning({ home, hiveHome, now: at(3), notify });
  const path = join(hiveHome, "briefings", `${TODAY}.md`);
  expect(sent).toEqual([`Morning proposals: today's briefing is ${path}`]);
  expect(r.outcome).toBe("told maya");
  for (const h of [4, 5, 8, 12, 23]) await runMorning({ home, hiveHome, now: at(h), notify });
  // A later firing that skips ("already complete") changes nothing.
  await appendFile(join(hiveHome, "logs", "nightly.log"), `=== HIVE nightly: ${TODAY} already complete — skipping (08:30:02) ===\n`);
  const again = await runMorning({ home, hiveHome, now: at(9), notify });
  expect(sent.length).toBe(1);
  expect(again.outcome).toMatch(/^already told maya at /);
  const state = JSON.parse(await readFile(morningFile(home), "utf-8"));
  expect(Object.keys(state.sent[TODAY])).toEqual(["complete"]);
});

test("after a failed nightly it says failed, once; a retry that completes sends the briefing", async () => {
  await nightly(TODAY, "failed");
  await runMorning({ home, hiveHome, now: at(3), notify });
  await runMorning({ home, hiveHome, now: at(4), notify });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain(`hive's nightly for ${TODAY} failed (=== HIVE nightly FAILED (rc=1) at 02:10:00 ===)`);
  expect(sent[0]).toContain("no briefing for today");
  // The 08:30 retry starts: silent while it runs, then the briefing once it completes.
  await nightly(TODAY, "running", "08:30:00");
  expect((await runMorning({ home, hiveHome, now: at(8, 40), notify })).run).toBe("running");
  expect(sent).toHaveLength(1);
  await nightly(TODAY, "complete", "08:30:00");
  await runMorning({ home, hiveHome, now: at(9), notify });
  await runMorning({ home, hiveHome, now: at(10), notify });
  expect(sent).toHaveLength(2);
  expect(sent[1]).toStartWith("Morning proposals: today's briefing is ");
});

test("a timeout counts as failed", async () => {
  await nightly(TODAY, "timeout");
  expect(readNightlyRun(TODAY, hiveHome)).toMatchObject({ state: "failed", line: "=== HIVE nightly TIMED OUT after 60m (rc=124) at 03:00:05 ===" });
});

test("a dry run says what it would send and records nothing; a failed delivery is retried next hour", async () => {
  await nightly(TODAY, "complete");
  const dry = await runMorning({ home, hiveHome, now: at(9), dryRun: true, notify });
  expect(dry.outcome).toBe("would tell maya");
  expect(formatMorning(dry)).toContain("(dry run: nothing sent)");
  expect(formatMorning(dry)).toContain("Morning proposals: today's briefing is ");
  expect(sent).toEqual([]);
  expect(existsSync(morningFile(home))).toBe(false);
  const down = await runMorning({ home, hiveHome, now: at(9), notify: async () => { throw new Error("relay down"); } });
  expect(down.outcome).toBe("not told maya: relay down");
  expect(existsSync(morningFile(home))).toBe(false);
  expect((await runMorning({ home, hiveHome, now: at(10), notify })).outcome).toBe("told maya");
});

test("a completed run with no briefing says so; the run folder's briefing.md stands in for briefings/", async () => {
  await nightly(TODAY, "complete");
  await rm(join(hiveHome, "briefings"), { recursive: true });
  expect((await runMorning({ home, hiveHome, now: at(9), dryRun: true })).message).toContain("completed but wrote no briefing");
  await writeFile(join(hiveHome, "memory", "runs", TODAY, "briefing.md"), "# b\n");
  expect(readNightlyRun(TODAY, hiveHome).briefing).toBe(join(hiveHome, "memory", "runs", TODAY, "briefing.md"));
});
