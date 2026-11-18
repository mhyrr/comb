import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UsageError } from "../errors";
import {
  GUARD_ENV, installStatusLine, isCombCommand, rateLimitsPath, readState, runTee, saveRateLimits,
  statePath, statusLineStatus, teeCommand, undoStatusLine,
} from "../statusline";

// Everything lives under a fake HOME: never the real ~/.claude or ~/.comb.
let dir: string;
let home: string;
let settingsPath: string;
const BIN = "/opt/comb/bin/comb";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "comb-statusline-"));
  home = join(dir, ".comb");
  settingsPath = join(dir, ".claude", "settings.json");
  await mkdir(home, { recursive: true });
  await mkdir(join(dir, ".claude"), { recursive: true });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const readSettings = async () => JSON.parse(await readFile(settingsPath, "utf-8")) as Record<string, unknown>;
const RL = { five_hour: { used_percentage: 47, resets_at: 1794962400 }, seven_day: { used_percentage: 32, resets_at: 1795374000 } };
const stdin = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const text = (b: Uint8Array) => new TextDecoder().decode(b);

async function script(name: string, body: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, `#!/bin/sh\n${body}\n`);
  await chmod(p, 0o755);
  return p;
}

/** Installs the tee over an old status line command, the way `comb init --install-statusline` does. */
async function installOver(command: string | null, extra: Record<string, unknown> = {}) {
  await writeFile(settingsPath, JSON.stringify({ model: "opus", ...(command ? { statusLine: { type: "command", command, ...extra } } : {}) }, null, 2));
  return installStatusLine({ home, settingsPath, bin: BIN, now: new Date("2026-11-17T22:00:00Z") });
}

describe("recognising comb's command", () => {
  test("bare, absolute and quoted forms match; other commands do not", () => {
    expect(isCombCommand("comb statusline")).toBe(true);
    expect(isCombCommand("/Users/x/.local/bin/comb statusline")).toBe(true);
    expect(isCombCommand(teeCommand("/Users/x/My Tools/comb"))).toBe(true);
    expect(isCombCommand("~/.vibe-island/bin/vibe-island-statusline")).toBe(false);
    expect(isCombCommand("notcomb statusline")).toBe(false);
    expect(isCombCommand(undefined)).toBe(false);
    expect(teeCommand("/Users/x/My Tools/comb")).toBe("'/Users/x/My Tools/comb' statusline");
  });
});

describe("install and undo", () => {
  test("install changes only the command, keeps other keys, backs up and remembers the old object", async () => {
    const r = await installOver("~/bin/old-status", { padding: 2, refreshInterval: 10 });
    expect(r.changed).toBe(true);
    expect(r.message).toContain("Undo with: comb init --undo-statusline");
    const s = await readSettings();
    expect(s.model).toBe("opus");
    expect(s.statusLine).toEqual({ type: "command", command: `${BIN} statusline`, padding: 2, refreshInterval: 10 });
    expect((await readState(home))!.previous).toEqual({ type: "command", command: "~/bin/old-status", padding: 2, refreshInterval: 10 });
    const backups = await readdir(join(home, "backups"));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(await readFile(join(home, "backups", backups[0]!), "utf-8")).statusLine.command).toBe("~/bin/old-status");
    expect(await statusLineStatus(settingsPath)).toEqual({ installed: true, command: `${BIN} statusline` });
  });

  test("installing twice keeps the first old command, so undo never restores comb itself", async () => {
    await installOver("~/bin/old-status");
    const again = await installStatusLine({ home, settingsPath, bin: BIN });
    expect(again.changed).toBe(false);
    expect((await readState(home))!.previous?.command).toBe("~/bin/old-status");
  });

  test("undo restores the old object exactly and forgets the install", async () => {
    await installOver("~/bin/old-status", { padding: 2 });
    const r = await undoStatusLine({ home, settingsPath });
    expect(r.changed).toBe(true);
    expect((await readSettings()).statusLine).toEqual({ type: "command", command: "~/bin/old-status", padding: 2 });
    expect(await readState(home)).toBeNull();
  });

  test("with no status line before, install adds one and undo removes the key", async () => {
    await installOver(null);
    expect((await readSettings()).statusLine).toEqual({ type: "command", command: `${BIN} statusline` });
    await undoStatusLine({ home, settingsPath });
    const s = await readSettings();
    expect("statusLine" in s).toBe(false);
    expect(s.model).toBe("opus");
  });

  test("undo refuses when someone has changed the status line since", async () => {
    await installOver("~/bin/old-status");
    const s = await readSettings();
    s.statusLine = { type: "command", command: "~/bin/newer" };
    await writeFile(settingsPath, JSON.stringify(s));
    const r = await undoStatusLine({ home, settingsPath });
    expect(r.changed).toBe(false);
    expect(r.message).toContain('now runs "~/bin/newer", not comb\'s tee; left as is');
    expect(((await readSettings()).statusLine as { command: string }).command).toBe("~/bin/newer");
  });

  test("undo knows the exact command it installed, whatever the binary is called", async () => {
    // Found end to end: a build named comb-bin, and any odd path, must still undo.
    await writeFile(settingsPath, JSON.stringify({ statusLine: { type: "command", command: "~/bin/old-status" } }));
    await installStatusLine({ home, settingsPath, bin: "/opt/tools/ctl" });
    expect(isCombCommand("/opt/tools/ctl statusline")).toBe(false);
    expect(await statusLineStatus(settingsPath, home)).toEqual({ installed: true, command: "/opt/tools/ctl statusline" });
    expect((await installStatusLine({ home, settingsPath, bin: "/opt/tools/ctl" })).changed).toBe(false);
    expect((await undoStatusLine({ home, settingsPath })).changed).toBe(true);
    expect(((await readSettings()).statusLine as { command: string }).command).toBe("~/bin/old-status");
    expect(isCombCommand("/repo/comb-bin statusline")).toBe(true);
  });

  test("undo without an install does nothing; a settings file that is not JSON is never written", async () => {
    expect((await undoStatusLine({ home, settingsPath })).changed).toBe(false);
    await writeFile(settingsPath, "{ not json");
    await expect(installStatusLine({ home, settingsPath, bin: BIN })).rejects.toThrow(UsageError);
    expect(await readFile(settingsPath, "utf-8")).toBe("{ not json");
  });

  test("a missing settings.json is created with just the tee", async () => {
    await rm(settingsPath, { force: true });
    await installStatusLine({ home, settingsPath, bin: BIN });
    expect(await readSettings()).toEqual({ statusLine: { type: "command", command: `${BIN} statusline` } });
  });
});

describe("the cache", () => {
  test("saves only rate_limits' two windows, with the time it saw them", async () => {
    const at = new Date("2026-11-17T21:15:00Z");
    expect(await saveRateLimits(stdin({ cwd: "/private/path", transcript_path: "/x.jsonl", rate_limits: { ...RL, spend_limit: { used_usd: 3 } } }), home, at)).toBe(true);
    const saved = await readFile(rateLimitsPath(home), "utf-8");
    expect(JSON.parse(saved)).toEqual({ at: at.toISOString(), rate_limits: RL });
    expect(saved).not.toContain("/private/path");
  });

  test("stdin without rate_limits, or not JSON, leaves the last reading alone", async () => {
    await saveRateLimits(stdin({ rate_limits: RL }), home);
    const before = await readFile(rateLimitsPath(home), "utf-8");
    expect(await saveRateLimits(stdin({ model: { id: "x" } }), home)).toBe(false);
    expect(await saveRateLimits(new TextEncoder().encode("{ torn"), home)).toBe(false);
    expect(await readFile(rateLimitsPath(home), "utf-8")).toBe(before);
  });
});

describe("the tee", () => {
  test("runs the old command with the same stdin and env, and passes its output through byte for byte", async () => {
    const old = await script("old.sh", `printf 'cols=%s ' "$COLUMNS"; cat; printf '\\033[2mdim\\033[0m'`);
    await installOver(old);
    const input = stdin({ rate_limits: RL, model: { display_name: "Opus" } });
    const r = await runTee(input, { home, env: { ...process.env, COLUMNS: "120" } });
    expect(r.code).toBe(0);
    expect(text(r.stdout)).toBe(`cols=120 ${text(input)}\u001b[2mdim\u001b[0m`);
    expect(JSON.parse(await readFile(rateLimitsPath(home), "utf-8")).rate_limits).toEqual(RL);
  });

  test("a failing old command keeps its stdout, stderr and exit code", async () => {
    await installOver(await script("fail.sh", "echo partial; echo broke >&2; exit 3"));
    const r = await runTee(stdin({}), { home });
    expect([r.code, text(r.stdout), text(r.stderr)]).toEqual([3, "partial\n", "broke\n"]);
  });

  test("an old command that no longer exists shows nothing, exits 0 and is logged", async () => {
    await installOver(join(dir, "gone-statusline"));
    const r = await runTee(stdin({ rate_limits: RL }), { home });
    expect([r.code, r.stdout.length, r.stderr.length]).toEqual([0, 0, 0]);
    expect(await readFile(join(home, "logs", "statusline.log"), "utf-8")).toContain("was not found");
    // The reading is still saved.
    expect(JSON.parse(await readFile(rateLimitsPath(home), "utf-8")).rate_limits).toEqual(RL);
  });

  test("with no old status line it saves the reading and prints nothing", async () => {
    await installOver(null);
    const r = await runTee(stdin({ rate_limits: RL }), { home });
    expect([r.code, r.stdout.length]).toEqual([0, 0]);
    expect(JSON.parse(await readFile(rateLimitsPath(home), "utf-8")).rate_limits).toEqual(RL);
  });

  test("the reading is saved before a slow old command finishes", async () => {
    await installOver(await script("slow.sh", "sleep 1; echo done"));
    const run = runTee(stdin({ rate_limits: RL }), { home });
    await Bun.sleep(300);
    expect(JSON.parse(await readFile(rateLimitsPath(home), "utf-8")).rate_limits).toEqual(RL);
    expect(text((await run).stdout)).toBe("done\n");
  });

  test("recursion: inside its own wrapped command, and when the old command is comb, it runs nothing", async () => {
    // The old status line calls comb again: the guard env stops the loop at one level.
    const loop = await script("loop.sh", `echo "guard=$${GUARD_ENV}"`);
    await installOver(loop);
    const r = await runTee(stdin({}), { home });
    expect(text(r.stdout)).toBe("guard=1\n");
    expect((await runTee(stdin({}), { home, env: { [GUARD_ENV]: "1" } })).stdout.length).toBe(0);
    // A saved "previous" that is itself comb's tee is never run.
    await writeFile(statePath(home), JSON.stringify({ previous: { type: "command", command: "comb statusline" }, installedAt: "", command: "comb statusline" }));
    expect((await runTee(stdin({}), { home })).stdout.length).toBe(0);
  });
});
