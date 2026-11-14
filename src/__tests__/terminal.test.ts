import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Run, RunResult } from "../claude";
import type { HiveClient } from "../hive";
import { startPage } from "../page/server";
import { agentWorkdir, findHiveBin, openInTerminal, terminalArgv } from "../terminal";

type Call = { argv: string[]; cwd: string };

/** A fake process runner: answers by the argv, records every call. */
function fakeRun(answer: (argv: string[]) => Partial<RunResult>): { run: Run; calls: Call[] } {
  const calls: Call[] = [];
  const run: Run = async (argv, opts) => {
    calls.push({ argv, cwd: opts.cwd });
    return { code: 0, stdout: "", stderr: "", ...answer(argv) };
  };
  return { run, calls };
}

const REX = "/Apps/Rex Beta.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex";
const HIVE = "/u/.local/bin/hive";
const sub = (argv: string[]) => argv.slice(2).join(" "); // drop rex and --autostart=false

/** Rex answers for a server with the given sessions and one app client. */
function rexAnswers(sessions: { session_id: string; label: string }[]) {
  return (argv: string[]): Partial<RunResult> => {
    if (argv[0] !== REX) return {};
    const s = sub(argv);
    if (s === "ls --json") return { stdout: JSON.stringify({ sessions }) };
    if (s.startsWith("new ")) return { stdout: JSON.stringify({ session_id: "session:new", initial_windows: [{ window_id: "window:1" }] }) };
    if (s.startsWith("window new")) return { stdout: JSON.stringify({ window_id: "window:2", block_ids: ["block:2"] }) };
    if (s === "client ls --json") return { stdout: JSON.stringify({ clients: [{ client_id: "client:cli", info: { kind: "cli" } }, { client_id: "client:app", info: { kind: "app" } }] }) };
    return {};
  };
}

describe("agentWorkdir", () => {
  const has = (...paths: string[]) => (p: string) => paths.includes(p);

  test("a plain agent works in its cwd", () => {
    expect(agentWorkdir({ name: "a", cwd: "/repo", worktree: false }, has("/repo"))).toBe("/repo");
    expect(agentWorkdir({ name: "a", cwd: "/gone", worktree: false }, has())).toBeNull();
  });

  test("a worktree agent's recorded cwd is already its worktree", () => {
    const wt = "/repo/.claude/worktrees/a";
    expect(agentWorkdir({ name: "a", cwd: wt, worktree: true }, has(wt))).toBe(wt);
  });

  test("a doubled worktree path resolves to the real one", () => {
    const wt = "/repo/.claude/worktrees/a";
    expect(agentWorkdir({ name: "a", cwd: `${wt}/.claude/worktrees/a`, worktree: true }, has(wt))).toBe(wt);
  });

  test("a repo-root cwd gets the worktree appended", () => {
    expect(agentWorkdir({ name: "a", cwd: "/repo", worktree: true }, has("/repo", "/repo/.claude/worktrees/a"))).toBe("/repo/.claude/worktrees/a");
  });

  test("another agent's worktree with a longer name does not match", () => {
    const cwd = "/repo/.claude/worktrees/ab";
    expect(agentWorkdir({ name: "a", cwd, worktree: true }, has(cwd))).toBe(cwd);
    expect(agentWorkdir({ name: "a", cwd, worktree: true }, has("/repo/.claude/worktrees/a"))).toBeNull();
  });
});

describe("openInTerminal", () => {
  const base = { name: "acme-api", dir: "/w/acme-api", env: {}, hive: HIVE };

  test("first use makes a 'comb' Rex session with a tab running hive attach, then shows it", async () => {
    const { run, calls } = fakeRun(rexAnswers([{ session_id: "session:x", label: "hive" }]));
    const out = await openInTerminal({ ...base, run, rex: REX });
    expect(out).toEqual({ via: "rex", dir: "/w/acme-api", command: "hive attach acme-api" });
    expect(calls.map((c) => c.argv)).toEqual([
      [REX, "--autostart=false", "ls", "--json"],
      [REX, "--autostart=false", "new", "comb", "-c", "/w/acme-api", "--window", "acme-api", "--keep-open", "--json", "--", HIVE, "attach", "acme-api"],
      [REX, "--autostart=false", "client", "ls", "--json"],
      [REX, "--autostart=false", "-C", "client:app", "do", "session.select", "session_id=session:new", "window_id=window:1"],
      ["open", "-a", "/Apps/Rex Beta.app"],
    ]);
  });

  test("later uses add a tab to the existing 'comb' session", async () => {
    const { run, calls } = fakeRun(rexAnswers([{ session_id: "session:comb", label: "comb" }]));
    await openInTerminal({ ...base, run, rex: REX });
    expect(calls[1]!.argv).toEqual([REX, "--autostart=false", "window", "new", "-s", "session:comb", "acme-api", "-c", "/w/acme-api", "--keep-open", "--json", "--", HIVE, "attach", "acme-api"]);
    expect(calls[3]!.argv).toContain("window_id=window:2");
  });

  test("without hive, the tab runs claude attach and the result says so", async () => {
    const { run, calls } = fakeRun(rexAnswers([]));
    const out = await openInTerminal({ ...base, run, rex: REX, hive: null });
    expect(out.command).toBe("claude attach acme-api");
    expect(out.note).toMatch(/hive is not installed/);
    expect(calls[1]!.argv.slice(-3)).toEqual(["claude", "attach", "acme-api"]);
  });

  test("falls back to Terminal.app when Rex fails, passing dir and command as arguments", async () => {
    const { run, calls } = fakeRun((argv) => (argv[0] === REX ? { code: 1, stderr: "server not running" } : {}));
    const out = await openInTerminal({ ...base, run, rex: REX });
    expect(out.via).toBe("terminal");
    const last = calls.at(-1)!.argv;
    expect(last[0]).toBe("osascript");
    expect(last.slice(-4)).toEqual(["/w/acme-api", HIVE, "attach", "acme-api"]);
    expect(last.join(" ")).toContain("quoted form of (item 1 of argv)");
  });

  test("with no Rex, goes straight to Terminal.app", async () => {
    const { run, calls } = fakeRun(() => ({}));
    expect((await openInTerminal({ ...base, run, rex: null })).via).toBe("terminal");
    expect(calls).toHaveLength(1);
  });

  test("fails visibly with both reasons when neither opens", async () => {
    const { run } = fakeRun((argv) => ({ code: 1, stderr: argv[0] === REX ? "no rex server" : "not allowed" }));
    await expect(openInTerminal({ ...base, run, rex: REX })).rejects.toThrow(/Rex: .*no rex server.*Terminal: .*not allowed/);
  });

  test("a hostile directory stays one argument, never script text", () => {
    const dir = `/tmp/x" & do shell script "rm -rf ~" & "`;
    const argv = terminalArgv(dir, ["hive", "attach", "a"]);
    expect(argv.at(-4)).toBe(dir);
    expect(argv.slice(0, -4).join(" ")).not.toContain("rm -rf");
  });

  test("finds hive on PATH, then in ~/.local/bin", () => {
    const local = (p: string) => p === "/u/.local/bin/hive";
    expect(findHiveBin(local, "/u", () => "/opt/bin/hive")).toBe("/opt/bin/hive");
    expect(findHiveBin(local, "/u", () => null)).toBe("/u/.local/bin/hive");
    expect(findHiveBin(() => false, "/u", () => null)).toBeNull();
  });
});

describe("POST /api/agent/:name/terminal", () => {
  let home: string;
  let work: string;
  let page: { url: string; stop: () => Promise<void> };
  let calls: Call[];
  const port = 47000 + Math.floor(Math.random() * 2000);
  const origin = `http://127.0.0.1:${port}`;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "comb-home-"));
    work = await mkdtemp(join(tmpdir(), "comb-work-"));
    const dir = join(home, "agents", "acme-api");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "session.json"), JSON.stringify({ name: "acme-api", sessionId: "s1", parent: "maya", cwd: work, worktree: false, project: null }));
    const fake = fakeRun(rexAnswers([]));
    calls = fake.calls;
    const hive = { close: async () => {} } as unknown as HiveClient;
    page = startPage({ port, home, claudeBin: "/bin/false", run: fake.run, pollMs: 60_000, hive, rexBin: REX, hiveBin: HIVE, hiveSetup: { enabled: true, mode: "on", bin: HIVE, home: "/nonexistent-hive", why: "test" } });
  });
  afterEach(async () => {
    await page.stop();
    await rm(home, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  const post = (name: string, headers: Record<string, string> = { origin }) =>
    fetch(`${page.url}/api/agent/${encodeURIComponent(name)}/terminal`, { method: "POST", headers });

  test("opens hive attach for a known agent in its directory", async () => {
    const res = await post("acme-api");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: "rex", dir: work, command: "hive attach acme-api" });
    const made = calls.find((c) => c.argv.includes("new"))!.argv;
    expect(made.slice(-6)).toEqual(["--keep-open", "--json", "--", HIVE, "attach", "acme-api"]);
    expect(made).toContain(work);
  });

  test("refuses unknown agents and names that are not agent names, running nothing", async () => {
    expect((await post("nobody")).status).toBe(404);
    expect((await post("../etc")).status).toBe(404);
    expect((await post("acme-api; rm -rf ~")).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("refuses a POST from another origin", async () => {
    expect((await post("acme-api", { origin: "http://evil.example" })).status).toBe(403);
    expect((await post("acme-api", {})).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("says so when the agent's directory is gone", async () => {
    await rm(work, { recursive: true, force: true });
    const res = await post("acme-api");
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(0);
  });
});

describe("the page without hive (D24)", () => {
  let home: string;
  let work: string;
  let page: { url: string; stop: () => Promise<void> };
  let calls: Call[];
  const port = 49000 + Math.floor(Math.random() * 900);
  const origin = `http://127.0.0.1:${port}`;
  const touched: string[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "comb-home-"));
    work = await mkdtemp(join(tmpdir(), "comb-work-"));
    const dir = join(home, "agents", "acme-api");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "charter.md"), "# acme-api\n");
    await writeFile(join(dir, "session.json"), JSON.stringify({ name: "acme-api", sessionId: "s1", parent: "maya", cwd: work, worktree: false, project: null }));
    const fake = fakeRun((argv) => (argv[1] === "agents" ? { stdout: "[]" } : rexAnswers([])(argv)));
    calls = fake.calls;
    // Any call into hive's MCP client is a failure: without hive it must never start.
    const hive = new Proxy({ close: async () => {} }, {
      get: (t, k) => (k === "close" ? t.close : () => { touched.push(String(k)); throw new Error("hive used"); }),
    }) as unknown as HiveClient;
    page = startPage({
      port, home, claudeBin: "claude", run: fake.run, pollMs: 60_000, hive, rexBin: REX, hiveBin: HIVE, nightlyMs: 60_000,
      hiveSetup: { enabled: false, mode: "auto", bin: "hive", home: "/nonexistent-hive", why: "test" },
    });
  });
  afterEach(async () => {
    await page.stop();
    await rm(home, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("tickets, memory and ticket starts answer 'not installed' without touching hive", async () => {
    const tickets = await fetch(`${page.url}/api/tickets`);
    expect(tickets.status).toBe(404);
    expect(await tickets.json()).toMatchObject({ hive: false });
    expect((await fetch(`${page.url}/api/memory?project=acme-api`)).status).toBe(404);
    expect((await fetch(`${page.url}/api/ticket?project=acme-api&id=TK-1`)).status).toBe(404);
    expect(await (await fetch(`${page.url}/api/projects`)).json()).toEqual({ projects: [] });
    const start = await fetch(`${page.url}/api/tickets/start`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ project: "acme-api", id: "TK-1" }) });
    expect(start.status).toBe(404);
    expect(touched).toEqual([]);
  });

  test("the snapshot says hive is off", async () => {
    const res = await fetch(`${page.url}/api/events`);
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("\n\n")) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(text).toContain('"hive":false');
  });

  test("Open in terminal runs claude attach, not hive attach", async () => {
    const res = await fetch(`${page.url}/api/agent/acme-api/terminal`, { method: "POST", headers: { origin } });
    expect(await res.json()).toMatchObject({ command: "claude attach acme-api" });
    expect(calls.some((c) => c.argv.includes(HIVE))).toBe(false);
  });
});
