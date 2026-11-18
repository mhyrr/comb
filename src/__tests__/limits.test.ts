import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readLimits, STALE_MS } from "../limits";
import { limitsHtml, resetTime, usageHtml } from "../page/ui/usage";
import { rateLimitsPath } from "../statusline";

// Noon local time; the session window resets at 7:40pm the same day, the week on Nov 22.
const NOW = new Date(2026, 10, 17, 12, 0, 0).getTime();
const SESSION_RESET = new Date(2026, 10, 17, 19, 40).getTime() / 1000;
const WEEK_RESET = new Date(2026, 10, 22, 14, 0).getTime() / 1000;
const RL = { five_hour: { used_percentage: 47, resets_at: SESSION_RESET }, seven_day: { used_percentage: 32, resets_at: WEEK_RESET } };

// A fake HOME: comb's home and Claude's settings.json, never the real ones.
let dir: string;
let home: string;
let settingsPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "comb-limits-"));
  home = join(dir, ".comb");
  settingsPath = join(dir, ".claude", "settings.json");
  await mkdir(join(home, "cache"), { recursive: true });
  await mkdir(join(dir, ".claude"), { recursive: true });
  await tee(true);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** Whether settings.json runs comb's tee. */
async function tee(installed: boolean) {
  const command = installed ? "/opt/comb statusline" : "~/bin/other-statusline";
  await writeFile(settingsPath, JSON.stringify({ statusLine: { type: "command", command } }));
}
/** What `comb statusline` saves. */
async function put(o: unknown, at = NOW - 60_000) {
  await writeFile(rateLimitsPath(home), typeof o === "string" ? o : JSON.stringify({ at: new Date(at).toISOString(), rate_limits: o }));
}
const read = (now = NOW) => readLimits({ home, settingsPath, now });

describe("readLimits", () => {
  test("reads the session and weekly windows, as of when the tee saw them", async () => {
    await put(RL);
    expect(await read()).toEqual({
      status: "ok",
      asOf: new Date(NOW - 60_000).toISOString(),
      stale: false,
      warning: null,
      windows: [
        { id: "five_hour", label: "Current session", usedPercent: 47, resetsAt: new Date(SESSION_RESET * 1000).toISOString(), reset: false },
        { id: "seven_day", label: "Current week (all models)", usedPercent: 32, resetsAt: new Date(WEEK_RESET * 1000).toISOString(), reset: false },
      ],
    });
  });

  test("no reading yet: with the tee in, it waits for the next reply; without it, it says how to install", async () => {
    expect(await read()).toEqual({ status: "missing", message: "Waiting for the first reading: it comes with the next Claude reply." });
    await tee(false);
    const l = await read();
    expect(l).toEqual({ status: "missing", message: "Plan limits come from comb's status line, which is not installed. Install: comb init --install-statusline" });
    const html = limitsHtml(l, NOW);
    expect(html).toContain("comb init --install-statusline");
    expect(html).not.toContain("u-meter");
  });

  test("the tee removed after a reading: the bars stay, with a warning that names what runs now", async () => {
    await put(RL);
    await tee(false);
    const l = await read();
    expect(l.status === "ok" && l.warning).toBe(
      `comb's status line is not installed (settings.json runs "~/bin/other-statusline"), so these bars stop updating. Install: comb init --install-statusline`,
    );
    expect(limitsHtml(l, NOW)).toContain("these bars stop updating");
  });

  test("a torn file or one without windows is unreadable, not a crash", async () => {
    await put("{ half");
    expect((await read()).status).toBe("unreadable");
    await put({ spend_limit: { used_usd: 1 } });
    expect((await read()).status).toBe("unreadable");
  });

  test("stale data is marked once the reading is older than half an hour", async () => {
    await put(RL, NOW - STALE_MS - 1000);
    const l = await read();
    expect(l.status === "ok" && l.stale).toBe(true);
    expect(limitsHtml(l, NOW)).toContain("It updates when a Claude session replies");
    await put(RL, NOW - STALE_MS + 1000);
    const fresh = await read();
    expect(fresh.status === "ok" && fresh.stale).toBe(false);
  });

  test("a window whose reset has passed drops its old percentage and says it reset", async () => {
    await put(RL);
    const after = new Date(2026, 10, 17, 20, 0).getTime();
    const l = await read(after);
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
    const l = await read();
    expect(l.status === "ok" && l.windows[0]!.usedPercent).toBe(100);
  });
});

describe("the bars", () => {
  test("show percent used and the reset time the way /usage does, with the Fable line, and no Vibe Island", async () => {
    await put(RL);
    const html = limitsHtml(await read(), NOW);
    expect(html).toContain("Current session");
    expect(html).toContain("47% used");
    expect(html).toContain("Resets 7:40pm");
    expect(html).toContain("Resets Nov 22 at 2:00pm");
    expect(html).toContain("Fable weekly: only in <code>/usage</code>");
    expect(html).toContain("As of 11:59am.");
    expect(html.toLowerCase()).not.toContain("vibe");
  });

  test("high use is marked; the limits sit above the token stats", async () => {
    await put({ five_hour: { used_percentage: 93, resets_at: SESSION_RESET } });
    const limits = await read();
    expect(limitsHtml(limits, NOW)).toContain('class="u-limit high"');
    const page = usageHtml({ ready: false, limits, error: null }, NOW);
    expect(page.indexOf("Current session")).toBeLessThan(page.indexOf("Reading transcripts"));
  });

  test("reset times: today as a time, another day with its date", () => {
    expect(resetTime(new Date(2026, 10, 17, 9, 5).toISOString(), NOW)).toBe("9:05am");
    expect(resetTime(new Date(2026, 10, 22, 13, 59).toISOString(), NOW)).toBe("Nov 22 at 1:59pm");
  });
});
