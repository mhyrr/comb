import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readLimits, STALE_MS } from "../limits";
import { limitsHtml, resetTime, usageHtml } from "../page/ui/usage";

// Noon local time; the session window resets at 7:40pm the same day, the week on Nov 22.
const NOW = new Date(2026, 10, 17, 12, 0, 0).getTime();
const SESSION_RESET = new Date(2026, 10, 17, 19, 40).getTime() / 1000;
const WEEK_RESET = new Date(2026, 10, 22, 14, 0).getTime() / 1000;
// What Vibe Island writes: Claude Code's statusLine `rate_limits`, as-is.
const RL = { five_hour: { used_percentage: 47, resets_at: SESSION_RESET }, seven_day: { used_percentage: 32, resets_at: WEEK_RESET } };

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "comb-limits-"));
  path = join(dir, "rl.json");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function put(o: unknown, mtime = NOW - 60_000) {
  await writeFile(path, typeof o === "string" ? o : JSON.stringify(o));
  await utimes(path, new Date(mtime), new Date(mtime));
}

describe("readLimits", () => {
  test("reads the session and weekly windows, as of the file's mtime", async () => {
    await put(RL);
    const l = await readLimits(path, NOW);
    expect(l).toEqual({
      status: "ok",
      source: path,
      asOf: new Date(NOW - 60_000).toISOString(),
      stale: false,
      windows: [
        { id: "five_hour", label: "Current session", usedPercent: 47, resetsAt: new Date(SESSION_RESET * 1000).toISOString(), reset: false },
        { id: "seven_day", label: "Current week (all models)", usedPercent: 32, resetsAt: new Date(WEEK_RESET * 1000).toISOString(), reset: false },
      ],
    });
  });

  test("a missing file says where the numbers come from", async () => {
    const l = await readLimits(join(dir, "nope.json"), NOW);
    expect(l).toEqual({ status: "missing", source: join(dir, "nope.json"), message: "Session limits come from Vibe Island's status line; not found." });
    const html = limitsHtml(l, NOW);
    expect(html).toContain("Session limits come from Vibe Island's status line; not found.");
    expect(html).not.toContain("u-meter");
  });

  test("a torn file or one without windows is unreadable, not a crash", async () => {
    await put("{ half");
    expect((await readLimits(path, NOW)).status).toBe("unreadable");
    await put({ spend_limit: { used_usd: 1 } });
    expect((await readLimits(path, NOW)).status).toBe("unreadable");
  });

  test("stale data is marked once the reading is older than half an hour", async () => {
    await put(RL, NOW - STALE_MS - 1000);
    const l = await readLimits(path, NOW);
    expect(l.status === "ok" && l.stale).toBe(true);
    expect(limitsHtml(l, NOW)).toContain("It updates when a Claude session replies");
    await put(RL, NOW - STALE_MS + 1000);
    const fresh = await readLimits(path, NOW);
    expect(fresh.status === "ok" && fresh.stale).toBe(false);
  });

  test("a window whose reset has passed drops its old percentage and says it reset", async () => {
    await put(RL);
    const after = new Date(2026, 10, 17, 20, 0).getTime();
    const l = await readLimits(path, after);
    if (l.status !== "ok") throw new Error(l.message);
    expect(l.windows[0]).toMatchObject({ id: "five_hour", usedPercent: null, reset: true });
    expect(l.windows[1]).toMatchObject({ id: "seven_day", usedPercent: 32, reset: false });
    const html = limitsHtml(l, after);
    expect(html).toContain("Reset 7:40pm. A new reading comes with the next Claude reply.");
    expect(html).not.toContain("47% used");
    expect(html).toContain("32% used");
  });

  test("percentages are clamped to 0–100", async () => {
    await put({ five_hour: { used_percentage: 104, resets_at: SESSION_RESET } });
    const l = await readLimits(path, NOW);
    expect(l.status === "ok" && l.windows[0]!.usedPercent).toBe(100);
  });
});

describe("the bars", () => {
  test("show percent used and the reset time the way /usage does, with the Fable line", async () => {
    await put(RL);
    const html = limitsHtml(await readLimits(path, NOW), NOW);
    expect(html).toContain("Current session");
    expect(html).toContain("47% used");
    expect(html).toContain("Resets 7:40pm");
    expect(html).toContain("Resets Nov 22 at 2:00pm");
    expect(html).toContain("Fable weekly: only in <code>/usage</code>");
    expect(html).toContain("As of 11:59am, from Vibe Island's status line.");
  });

  test("high use is marked; the limits sit above the token stats", async () => {
    await put({ five_hour: { used_percentage: 93, resets_at: SESSION_RESET } });
    const limits = await readLimits(path, NOW);
    expect(limitsHtml(limits, NOW)).toContain('class="u-limit high"');
    const page = usageHtml({ ready: false, limits, error: null }, NOW);
    expect(page.indexOf("Current session")).toBeLessThan(page.indexOf("Reading transcripts"));
  });

  test("reset times: today as a time, another day with its date", () => {
    expect(resetTime(new Date(2026, 10, 17, 9, 5).toISOString(), NOW)).toBe("9:05am");
    expect(resetTime(new Date(2026, 10, 22, 13, 59).toISOString(), NOW)).toBe("Nov 22 at 1:59pm");
  });
});
