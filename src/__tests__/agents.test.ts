import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentDir, agentPreamble, listAgents, readAgentSession, sendToAgent, startAgent, validateAgentName } from "../agents";
import { buildStartArgv, childEnv, parseBackgrounded, type LiveSession, type Run } from "../claude";
import { projectForDir, type HiveSetup } from "../hive";
import { incoming } from "../transcript";

/**
 * A stand-in for the claude CLI. `--bg` "starts" a session and adds it to the
 * list that `agents --json` returns; every call is recorded.
 */
function fakeClaude(initial: LiveSession[] = []) {
  const sessions = [...initial];
  let identity: { code: number; stdout: string; stderr: string } | null = null;
  const calls: { argv: string[]; cwd: string; env: Record<string, string>; stdin?: string }[] = [];
  let relayReply = "SENT";
  let next = 0;
  let bgOutput: ((id: string, name: string) => { code: number; stdout: string; stderr: string }) | null = null;
  // Claude Code moves a -w session into its worktree; when that lands before
  // `agents --json` lists it, the listed cwd is already the worktree.
  let movedBeforeListing = false;
  const run: Run = async (argv, opts) => {
    calls.push({ argv, cwd: opts.cwd, env: opts.env, stdin: opts.stdin });
    if (argv[1] === "-p") return { code: 0, stdout: `${relayReply}\n`, stderr: "" };
    if (argv[1] === "identity") return identity ?? { code: 0, stdout: `IDENTITY for ${opts.cwd}\n`, stderr: "" };
    if (argv[1] === "agents") return { code: 0, stdout: JSON.stringify(sessions), stderr: "" };
    if (argv[1] === "stop") {
      const at = sessions.findIndex((s) => s.id === argv[2]);
      if (at >= 0) sessions.splice(at, 1);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (argv[1] === "--bg") {
      const name = argv[argv.indexOf("-n") + 1]!;
      const resumeAt = argv.indexOf("--resume");
      const id = resumeAt >= 0 ? argv[resumeAt + 1]!.slice(0, 8) : `abc${String(next++).padStart(5, "0")}`;
      if (bgOutput) return bgOutput(id, name);
      const sessionId = resumeAt >= 0 ? argv[resumeAt + 1]! : `${id}-0000-0000-0000-000000000000`;
      const at = sessions.findIndex((s) => s.sessionId === sessionId);
      if (at >= 0) sessions.splice(at, 1);
      const moved = movedBeforeListing && argv.includes("-w");
      sessions.push({ id, sessionId, name, cwd: moved ? join(opts.cwd, ".claude", "worktrees", name) : opts.cwd, state: "working" });
      return { code: 0, stdout: `backgrounded · ${id} · ${name}\n`, stderr: "" };
    }
    throw new Error(`unexpected claude call: ${argv.join(" ")}`);
  };
  return {
    run, calls, sessions,
    failBg: (f: typeof bgOutput) => { bgOutput = f; },
    moveBeforeListing: () => { movedBeforeListing = true; },
    failIdentity: () => { identity = { code: 1, stdout: "", stderr: "no hive" }; },
    relayReplies: (text: string) => { relayReply = text; },
  };
}

const noWait = async () => {};

describe("comb agents", () => {
  let root: string;
  let home: string;
  let repo: string;
  const saved = { hive: process.env.HIVE_HOME, key: process.env.ANTHROPIC_API_KEY };

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "comb-agents-")));
    home = join(root, "comb");
    repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    // Project lookup reads ~/.hive; point it at a fixture so tests never read the real one.
    process.env.HIVE_HOME = join(root, "hive");
    await mkdir(process.env.HIVE_HOME, { recursive: true });
    process.env.COMB_MCP_BIN = "/bin/comb-mcp-test";
    // These tests are Greg's install: hive on, and his name in config.json.
    // Pinning hive on keeps them from depending on whether this machine has it.
    process.env.COMB_HIVE = "on";
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify({ userName: "Greg" }));
  });

  afterEach(async () => {
    if (saved.hive === undefined) delete process.env.HIVE_HOME; else process.env.HIVE_HOME = saved.hive;
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
    delete process.env.COMB_MCP_BIN;
    delete process.env.COMB_HIVE;
    await rm(root, { recursive: true, force: true });
  });

  test("a new agent gets a workspace, a session record and a log line", async () => {
    const claude = fakeClaude();
    const { session, restarted, dir } = await startAgent({
      name: "acme-api", charter: "Own the acme-api project.", cwd: repo, home,
      claudeBin: "claude", run: claude.run, wait: noWait,
    });

    expect(restarted).toBe(false);
    expect(dir).toBe(agentDir("acme-api", home));
    expect(await readFile(join(dir, "charter.md"), "utf-8")).toBe("Own the acme-api project.\n");
    for (const f of ["checklist.md", "log.md", "system-prompt.md", "mcp.json", "session.json"]) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
    expect(existsSync(join(dir, "reports"))).toBe(true);
    expect(existsSync(join(dir, "memory"))).toBe(true);

    expect(session).toMatchObject({ name: "acme-api", parent: "greg", cwd: repo, harness: "claude", permissionMode: "auto" });
    expect(JSON.parse(await readFile(join(dir, "session.json"), "utf-8")).sessionId).toBe(session.sessionId);
    expect(await readFile(join(dir, "log.md"), "utf-8")).toContain(`started by greg in ${repo} (session ${session.id}, model opus)`);

    const prompt = await readFile(join(dir, "system-prompt.md"), "utf-8");
    expect(prompt.startsWith(`IDENTITY for ${repo}`)).toBe(true);
    expect(prompt).toContain('Here you are the comb agent "acme-api", and your role is your charter.');
    expect(prompt).toContain("Decide and act when the step is reversible");
    expect(prompt).toContain("Your parent is Greg.");

    const mcp = JSON.parse(await readFile(join(dir, "mcp.json"), "utf-8"));
    expect(mcp.mcpServers.comb).toMatchObject({ command: "/bin/comb-mcp-test", env: { COMB_AGENT: "acme-api", COMB_HOME: home } });
  });

  test("the session starts detached on the subscription, with identity in the prompt", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    const claude = fakeClaude();
    await startAgent({ name: "mobile-app", charter: "c", cwd: repo, home, claudeBin: "claude", run: claude.run, wait: noWait });

    const bg = claude.calls.find((c) => c.argv[1] === "--bg")!;
    expect(bg.cwd).toBe(repo);
    expect(bg.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(bg.env.HIVE_IDENTITY_IN_PROMPT).toBe("1");
    const dir = agentDir("mobile-app", home);
    expect(bg.argv).toEqual([
      "claude", "--bg", "--mcp-config", join(dir, "mcp.json"),
      "-n", "mobile-app", "--permission-mode", "auto", "--model", "opus",
      "--append-system-prompt-file", join(dir, "system-prompt.md"),
      "Read your charter.md and checklist.md, then begin.",
    ]);
  });

  test("a model is passed on every start and kept for restarts in settings.json", async () => {
    const claude = fakeClaude();
    const base = { home, claudeBin: "claude", run: claude.run, wait: noWait };
    const first = await startAgent({ name: "maya", charter: "c", cwd: repo, model: "opus", ...base });
    expect(first.session.model).toBe("opus");
    const bgArgv = () => claude.calls.filter((c) => c.argv[1] === "--bg").at(-1)!.argv;
    expect(bgArgv().slice(0, 9)).toEqual(["claude", "--bg", "--mcp-config", join(first.dir, "mcp.json"), "-n", "maya", "--permission-mode", "auto", "--model"]);
    expect(bgArgv()[9]).toBe("opus");
    expect(JSON.parse(await readFile(join(first.dir, "settings.json"), "utf-8"))).toEqual({ model: "opus" });

    // Asleep, then woken by a message: same model, without anyone naming it.
    claude.sessions.length = 0;
    await sendToAgent({ name: "maya", message: "go", ...base });
    expect(bgArgv()).toContain("--resume");
    expect(bgArgv()[bgArgv().indexOf("--model") + 1]).toBe("opus");
  });

  test("with no model named, config.json's defaultModel is used and saved (opus unless set)", async () => {
    const claude = fakeClaude();
    const base = { home, claudeBin: "claude", run: claude.run, wait: noWait };
    const modelOf = (name: string) => {
      const argv = claude.calls.filter((c) => c.argv[1] === "--bg" && c.argv.includes(name)).at(-1)!.argv;
      return argv[argv.indexOf("--model") + 1];
    };
    const plain = await startAgent({ name: "plain", charter: "c", cwd: repo, ...base });
    expect(modelOf("plain")).toBe("opus");
    expect(plain.session.model).toBe("opus");
    expect(JSON.parse(await readFile(join(plain.dir, "settings.json"), "utf-8"))).toEqual({ model: "opus" });

    await writeFile(join(home, "config.json"), JSON.stringify({ defaultModel: "sonnet" }));
    await startAgent({ name: "routine", charter: "c", cwd: repo, ...base });
    expect(modelOf("routine")).toBe("sonnet");
    // A named model wins over the default, and an agent keeps its own model when the default changes.
    await startAgent({ name: "picked", charter: "c", cwd: repo, model: "fable", ...base });
    expect(modelOf("picked")).toBe("fable");
    claude.sessions.length = 0;
    await sendToAgent({ name: "plain", message: "go", ...base });
    expect(modelOf("plain")).toBe("opus");
  });

  test("a child names its parent and how to reach it", async () => {
    const claude = fakeClaude();
    const { dir } = await startAgent({
      name: "rate-limiter", charter: "Build TK-142.", parent: "acme-api", worktree: true, cwd: repo, home,
      claudeBin: "claude", run: claude.run, wait: noWait,
    });
    expect(await readFile(join(dir, "system-prompt.md"), "utf-8")).toContain('Your parent is the agent "acme-api". Tell it with `agent_send`');
    const bg = claude.calls.find((c) => c.argv[1] === "--bg")!;
    expect(bg.argv.slice(-3)).toEqual(["-w", "rate-limiter", "Read your charter.md and checklist.md, then begin."]);
  });

  test("a new agent needs a charter; an existing one refuses a new charter", async () => {
    const claude = fakeClaude();
    const base = { cwd: repo, home, claudeBin: "claude", run: claude.run, wait: noWait };
    await expect(startAgent({ name: "notes", ...base })).rejects.toThrow("Give it a charter");
    await startAgent({ name: "notes", charter: "first", ...base });
    await expect(startAgent({ name: "notes", charter: "second", ...base })).rejects.toThrow("already exists");
    expect(await readFile(join(agentDir("notes", home), "charter.md"), "utf-8")).toBe("first\n");
  });

  test("a running session with the same name blocks the start", async () => {
    const claude = fakeClaude([{ id: "deadbeef", sessionId: "deadbeef-x", name: "hive", cwd: "/elsewhere", state: "working" }]);
    await expect(startAgent({
      name: "hive", charter: "c", cwd: repo, home, claudeBin: "claude", run: claude.run, wait: noWait,
    })).rejects.toThrow('A session named "hive" is already running');
    expect(existsSync(agentDir("hive", home))).toBe(false);
  });

  test("restart without a charter resumes the agent's own session", async () => {
    const claude = fakeClaude();
    const base = { home, claudeBin: "claude", run: claude.run, wait: noWait };
    const first = await startAgent({ name: "billing", charter: "c", cwd: repo, ...base });
    claude.sessions[0]!.state = "done";

    const second = await startAgent({ name: "billing", ...base });
    expect(second.restarted).toBe(true);
    const bg = claude.calls.filter((c) => c.argv[1] === "--bg").at(-1)!;
    expect(bg.cwd).toBe(repo);
    expect(bg.argv).toContain("--resume");
    expect(bg.argv[bg.argv.indexOf("--resume") + 1]).toBe(first.session.sessionId);
    expect(bg.argv.at(-1)).toContain("You were restarted from your workspace.");
    expect(await readFile(join(agentDir("billing", home), "log.md"), "utf-8")).toContain("resumed by greg");
  });

  test("a fresh restart starts a new conversation from the workspace and records it", async () => {
    const claude = fakeClaude();
    const base = { home, claudeBin: "claude", run: claude.run, wait: noWait };
    const first = await startAgent({ name: "billing", charter: "c", cwd: repo, ...base });
    claude.sessions[0]!.state = "done";

    const second = await startAgent({ name: "billing", fresh: true, ...base });
    expect(second.restarted).toBe(true);
    const bg = claude.calls.filter((c) => c.argv[1] === "--bg").at(-1)!;
    expect(bg.cwd).toBe(repo);
    expect(bg.argv).not.toContain("--resume");
    expect(bg.argv.at(-1)).toContain("Read charter.md, checklist.md, memory/ and the end of log.md");
    expect(second.session.sessionId).not.toBe(first.session.sessionId);
    const saved = JSON.parse(await readFile(join(agentDir("billing", home), "session.json"), "utf-8"));
    expect(saved.sessionId).toBe(second.session.sessionId);
    expect(saved.cwd).toBe(repo);
    expect(await readFile(join(agentDir("billing", home), "log.md"), "utf-8")).toContain("restarted fresh by greg");
  });

  test("a fresh restart stops the agent's live session, so the name stays unique", async () => {
    const claude = fakeClaude();
    const base = { home, claudeBin: "claude", run: claude.run, wait: noWait };
    const first = await startAgent({ name: "maya", charter: "c", cwd: repo, ...base });
    // Still on a turn: without fresh, this start is refused.
    await expect(startAgent({ name: "maya", ...base })).rejects.toThrow("already running");

    await startAgent({ name: "maya", fresh: true, ...base });
    expect(claude.calls.find((c) => c.argv[1] === "stop")!.argv).toEqual(["claude", "stop", first.session.id]);
    expect(claude.sessions.filter((s) => s.name === "maya")).toHaveLength(1);
    expect(claude.sessions[0]!.sessionId).not.toBe(first.session.sessionId);
  });

  test("a fresh restart that fails its checks leaves the live session running", async () => {
    const claude = fakeClaude();
    const base = { home, claudeBin: "claude", run: claude.run, wait: noWait };
    await startAgent({ name: "maya", charter: "c", cwd: repo, ...base });
    await expect(startAgent({ name: "maya", fresh: true, cwd: join(root, "gone"), ...base })).rejects.toThrow("does not exist");
    expect(claude.calls.filter((c) => c.argv[1] === "stop")).toHaveLength(0);
  });

  test("fresh on a new agent is an ordinary first start", async () => {
    const claude = fakeClaude();
    const { session } = await startAgent({
      name: "billing", charter: "c", cwd: repo, fresh: true, home, claudeBin: "claude", run: claude.run, wait: noWait,
    });
    expect(await readFile(join(agentDir("billing", home), "log.md"), "utf-8")).toContain(`started by greg in ${repo} (session ${session.id}`);
  });

  test("a session the daemon retired for idling is listed as done and resumes", async () => {
    const claude = fakeClaude();
    const base = { home, claudeBin: "claude", run: claude.run, wait: noWait };
    const first = await startAgent({ name: "maya", charter: "c", cwd: repo, ...base });
    // What `claude agents` shows after "bg retire …: idle-prompt, idle 3h".
    claude.sessions[0] = { ...claude.sessions[0]!, kind: "background", state: "blocked", status: undefined };

    const rows = await listAgents(base);
    expect(rows.map((r) => [r.name, r.state])).toEqual([["maya", "ready"]]);

    await startAgent({ name: "maya", ...base });
    const bg = claude.calls.filter((c) => c.argv[1] === "--bg").at(-1)!;
    expect(bg.argv[bg.argv.indexOf("--resume") + 1]).toBe(first.session.sessionId);
  });

  test("a live background session with the same name still blocks the start", async () => {
    const claude = fakeClaude([
      { id: "deadbeef", sessionId: "deadbeef-x", name: "hive", cwd: "/x", kind: "background", state: "blocked", status: "idle" },
    ]);
    await expect(startAgent({
      name: "hive", charter: "c", cwd: repo, home, claudeBin: "claude", run: claude.run, wait: noWait,
    })).rejects.toThrow("already running");
  });

  test("an untrusted folder is reported plainly", async () => {
    const claude = fakeClaude();
    claude.failBg(() => ({ code: 1, stdout: "Workspace not trusted. Run `claude` in /x once ...\n", stderr: "" }));
    await expect(startAgent({
      name: "shop-api", charter: "c", cwd: repo, home, claudeBin: "claude", run: claude.run, wait: noWait,
    })).rejects.toThrow("Claude has not trusted");
    // Nothing left behind, so the same start can be retried.
    expect(existsSync(agentDir("shop-api", home))).toBe(false);
  });

  test("a session that fails at start is reported, not waited on", async () => {
    const claude = fakeClaude();
    claude.failBg((id, name) => {
      claude.sessions.push({ id, sessionId: `${id}-s`, name, cwd: repo, state: "failed" });
      return { code: 0, stdout: `backgrounded · ${id} · ${name}\n`, stderr: "" };
    });
    await expect(startAgent({
      name: "shop-api", charter: "c", cwd: repo, home, claudeBin: "claude", run: claude.run, wait: noWait,
    })).rejects.toThrow("failed at start");
    expect(claude.calls.filter((c) => c.argv[1] === "agents" && c.argv.includes("--all"))).toHaveLength(1);
    expect(existsSync(agentDir("shop-api", home))).toBe(false);
  });

  test("the prompt never directly follows --mcp-config", () => {
    for (const extra of [{}, { worktree: true }, { resume: "sid" }]) {
      const argv = buildStartArgv("claude", {
        name: "a", cwd: "/r", systemPromptFile: "/s", mcpConfigFile: "/m", prompt: "p", permissionMode: "auto", ...extra,
      });
      expect(argv[argv.indexOf("--mcp-config") + 2]!.startsWith("-")).toBe(true);
      expect(argv.at(-1)).toBe("p");
    }
  });

  test("the roster shows working or ready, what each is for, and the last log line", async () => {
    const claude = fakeClaude();
    const base = { cwd: repo, home, claudeBin: "claude", run: claude.run, wait: noWait };
    await startAgent({ name: "alpha", charter: "# Alpha\n\nOwns the alpha project.", ...base });
    await startAgent({ name: "beta", charter: "Ships beta.", parent: "alpha", ...base });
    claude.sessions.splice(0, 1); // alpha's session is gone
    claude.sessions[0]!.status = "busy";

    const rows = await listAgents({ home, claudeBin: "claude", run: claude.run });
    expect(rows.map((r) => [r.name, r.state, r.about, r.parent])).toEqual([
      ["alpha", "ready", "Alpha", "greg"],
      ["beta", "working", "Ships beta.", "alpha"],
    ]);
    expect(rows[1]!.lastLog).toContain("started by alpha");
  });

  test("send to a live agent relays the message, with who to reply to", async () => {
    const claude = fakeClaude();
    const base = { home, claudeBin: "claude", run: claude.run, wait: noWait };
    await startAgent({ name: "maya", charter: "c", cwd: repo, ...base });
    claude.sessions[0] = { ...claude.sessions[0]!, kind: "background", state: "blocked", status: "idle" };

    const { woke } = await sendToAgent({ name: "maya", message: "what's waiting on me?", from: "hive-e8", ...base });
    expect(woke).toBe(false);
    const relay = claude.calls.find((c) => c.argv[1] === "-p")!;
    expect(relay.argv).toEqual(["claude", "-p", "--model", "haiku", "--allowedTools", "SendMessage"]);
    expect(relay.stdin).toContain('to "maya"');
    expect(relay.stdin).toContain('Reply with the comb agent_send tool to "hive-e8".');
    expect(relay.stdin).toContain("what's waiting on me?");
    expect(relay.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(claude.calls.filter((c) => c.argv[1] === "--bg")).toHaveLength(1);
  });

  test("a message from the page is signed as Greg's and asks for no agent_send reply", async () => {
    const claude = fakeClaude();
    const base = { home, claudeBin: "claude", run: claude.run, wait: noWait };
    await startAgent({ name: "maya", charter: "c", cwd: repo, ...base });
    claude.sessions[0] = { ...claude.sessions[0]!, kind: "background", state: "blocked", status: "idle" };

    await sendToAgent({ name: "maya", message: "what's waiting on me?", fromPage: true, ...base });
    const relay = claude.calls.find((c) => c.argv[1] === "-p")!;
    const body = relay.stdin!.split("<<<MESSAGE\n")[1]!.split("\nMESSAGE>>>")[0]!;
    // The page reads it back from the transcript as Greg's own words.
    expect(incoming(body, "comb")).toEqual({ from: "greg", text: "what's waiting on me?" });
    expect(body).not.toContain("Reply with the comb agent_send tool");
    expect(await readFile(join(agentDir("maya", home), "log.md"), "utf-8")).toContain("message from greg (page) delivered");
  });

  test("send to an asleep agent resumes it with the message and keeps its parent", async () => {
    const claude = fakeClaude();
    const base = { home, claudeBin: "claude", run: claude.run, wait: noWait };
    const first = await startAgent({ name: "acme-api", charter: "c", cwd: repo, parent: "maya", ...base });
    claude.sessions[0] = { ...claude.sessions[0]!, kind: "background", state: "blocked", status: undefined };

    const { woke, session } = await sendToAgent({ name: "acme-api", message: "take TK-143", from: "maya", ...base });
    expect(woke).toBe(true);
    expect(session!.parent).toBe("maya");
    const bg = claude.calls.filter((c) => c.argv[1] === "--bg").at(-1)!;
    expect(bg.argv[bg.argv.indexOf("--resume") + 1]).toBe(first.session.sessionId);
    expect(bg.argv.at(-1)).toContain("take TK-143");
    expect(claude.calls.some((c) => c.argv[1] === "-p")).toBe(false);
  });

  test("send to an agent whose worktree was removed wakes it in its workspace, told why", async () => {
    const claude = fakeClaude();
    const base = { home, claudeBin: "claude", run: claude.run, wait: noWait };
    const tree = join(root, "worktree");
    await mkdir(tree, { recursive: true });
    await startAgent({ name: "acme-api", charter: "c", cwd: tree, parent: "maya", ...base });
    claude.sessions[0] = { ...claude.sessions[0]!, kind: "background", state: "done", status: undefined };
    await rm(tree, { recursive: true });

    const { woke, session } = await sendToAgent({ name: "acme-api", message: "close out", from: "maya", ...base });
    expect(woke).toBe(true);
    const bg = claude.calls.filter((c) => c.argv[1] === "--bg").at(-1)!;
    expect(bg.cwd).toBe(agentDir("acme-api", home));
    // Its history lived in the removed folder, so this is a new session.
    expect(bg.argv).not.toContain("--resume");
    expect(bg.argv.at(-1)).toContain(`${tree} no longer exists`);
    expect(bg.argv.at(-1)).toContain("close out");
    // The next wake resumes there, and keeps its parent.
    expect(session!.cwd).toBe(agentDir("acme-api", home));
    expect(session!.parent).toBe("maya");
  });

  test("send reaches a session that is not an agent, such as Greg's", async () => {
    const claude = fakeClaude([{ id: "x", sessionId: "s-1", name: "hive-e8", cwd: repo, kind: "interactive", status: "idle", pid: 42 }]);
    const { woke } = await sendToAgent({ name: "hive-e8", message: "done", from: "hive-a1", home, claudeBin: "claude", run: claude.run });
    expect(woke).toBe(false);
    expect(claude.calls.find((c) => c.argv[1] === "-p")!.stdin).toContain('to "hive-e8"');
  });

  test("an agent answers Greg's session that wrote to it, but never hands one work", async () => {
    const greg = { id: "x", sessionId: "s-g", name: "docs-site-71", cwd: repo, kind: "interactive", status: "idle", pid: 42 };
    const claude = fakeClaude([greg]);
    const base = { home, claudeBin: "claude", run: claude.run, wait: noWait };
    await startAgent({ name: "maya", charter: "c", cwd: repo, ...base });
    const maya = claude.sessions.find((s) => s.name === "maya")!;
    Object.assign(maya, { kind: "background", state: "blocked", status: "idle" });

    // Cold: Maya may not route work into Greg's own session.
    await expect(sendToAgent({ name: "docs-site-71", message: "drop the at-risk view", from: "maya", ...base }))
      .rejects.toThrow("one of Greg's own sessions, outside the tree");
    expect(claude.calls.some((c) => c.argv[1] === "-p")).toBe(false);

    // Once that session writes to Maya, she can answer it.
    await sendToAgent({ name: "maya", message: "what's waiting?", from: "docs-site-71", ...base });
    await sendToAgent({ name: "docs-site-71", message: "two things", from: "maya", ...base });
    expect(claude.calls.filter((c) => c.argv[1] === "-p").at(-1)!.stdin).toContain('to "docs-site-71"');
  });

  test("a wake stops a finished session that kept its process, so the name stays unique", async () => {
    const claude = fakeClaude();
    const base = { home, claudeBin: "claude", run: claude.run, wait: noWait };
    const first = await startAgent({ name: "maya", charter: "c", cwd: repo, ...base });
    // Claude Code marks a finished turn done but keeps the process.
    Object.assign(claude.sessions[0]!, { kind: "background", state: "done", status: "idle", pid: 4242 });

    await sendToAgent({ name: "maya", message: "go", fromPage: true, ...base });
    expect(claude.calls.find((c) => c.argv[1] === "stop")!.argv).toEqual(["claude", "stop", first.session.id]);
    expect(claude.sessions.filter((s) => s.name === "maya")).toHaveLength(1);
  });

  test("a worktree agent records its worktree, so a wake resumes there", async () => {
    const claude = fakeClaude();
    const base = { home, claudeBin: "claude", run: claude.run, wait: noWait };
    const { session } = await startAgent({ name: "comb-status-text", charter: "c", cwd: repo, worktree: true, parent: "maya", ...base });
    expect(session.cwd).toBe(join(repo, ".claude", "worktrees", "comb-status-text"));
  });

  test("a worktree agent listed after it moved records its worktree once (TK-002)", async () => {
    const claude = fakeClaude();
    claude.moveBeforeListing();
    const base = { home, claudeBin: "claude", run: claude.run, wait: noWait };
    const { session } = await startAgent({ name: "seodash-tk-039", charter: "c", cwd: repo, worktree: true, parent: "maya", ...base });
    expect(session.cwd).toBe(join(repo, ".claude", "worktrees", "seodash-tk-039"));
  });

  test("a doubled worktree cwd is repaired when read, so a wake works (TK-002)", async () => {
    const claude = fakeClaude();
    const base = { home, claudeBin: "claude", run: claude.run, wait: noWait };
    const worktree = join(repo, ".claude", "worktrees", "seodash-tk-039");
    await mkdir(worktree, { recursive: true });
    const { session } = await startAgent({ name: "seodash-tk-039", charter: "c", cwd: repo, worktree: true, parent: "maya", ...base });
    // What a start that hit the doubling bug left behind.
    const file = join(agentDir("seodash-tk-039", home), "session.json");
    const doubled = join(worktree, ".claude", "worktrees", "seodash-tk-039");
    await writeFile(file, JSON.stringify({ ...session, cwd: doubled }, null, 2) + "\n");
    claude.sessions[0] = { ...claude.sessions[0]!, kind: "background", state: "blocked", status: undefined };

    expect((await readAgentSession("seodash-tk-039", home))!.cwd).toBe(worktree);
    expect(JSON.parse(await readFile(file, "utf-8")).cwd).toBe(worktree);
    await sendToAgent({ name: "seodash-tk-039", message: "sign off", from: "maya", ...base });
    expect(claude.calls.filter((c) => c.argv[1] === "--bg").at(-1)!.cwd).toBe(worktree);
  });

  test("a missing cwd that is not a doubled worktree is left alone", async () => {
    const claude = fakeClaude();
    const base = { home, claudeBin: "claude", run: claude.run, wait: noWait };
    const { session } = await startAgent({ name: "maya", charter: "c", cwd: repo, ...base });
    const file = join(agentDir("maya", home), "session.json");
    const gone = join(root, "gone");
    await writeFile(file, JSON.stringify({ ...session, cwd: gone }, null, 2) + "\n");
    expect((await readAgentSession("maya", home))!.cwd).toBe(gone);
  });

  test("waking an agent with a message logs who sent it", async () => {
    const claude = fakeClaude();
    const base = { home, claudeBin: "claude", run: claude.run, wait: noWait };
    await startAgent({ name: "maya", charter: "c", cwd: repo, ...base });
    claude.sessions[0] = { ...claude.sessions[0]!, kind: "background", state: "blocked", status: undefined };
    await sendToAgent({ name: "maya", message: "hi", from: "comb-c8", ...base });
    expect(await readFile(join(agentDir("maya", home), "log.md"), "utf-8")).toContain("message from comb-c8 delivered (woke)");
  });

  test("send to nobody, or a failed relay, is an error", async () => {
    const claude = fakeClaude();
    const base = { home, claudeBin: "claude", run: claude.run, wait: noWait };
    await expect(sendToAgent({ name: "nobody", message: "hi", ...base })).rejects.toThrow('no agent or session named "nobody"');

    await startAgent({ name: "maya", charter: "c", cwd: repo, ...base });
    claude.sessions[0]!.status = "idle";
    claude.relayReplies("FAILED: No agent named 'maya' is reachable.");
    await expect(sendToAgent({ name: "maya", message: "hi", ...base })).rejects.toThrow("Could not deliver to maya");
  });

  test("identity comes from hive in the agent's directory; a failure writes nothing", async () => {
    const ok = fakeClaude();
    await startAgent({ name: "hive", charter: "c", cwd: repo, home, claudeBin: "claude", run: ok.run, wait: noWait });
    const emit = ok.calls.find((c) => c.argv[1] === "identity")!;
    expect(emit.argv).toEqual(["hive", "identity", "emit"]);
    expect(emit.cwd).toBe(repo);

    const broken = fakeClaude();
    broken.failIdentity();
    await expect(startAgent({
      name: "notes", charter: "c", cwd: repo, home, claudeBin: "claude", run: broken.run, wait: noWait,
    })).rejects.toThrow("hive identity emit failed");
    expect(existsSync(agentDir("notes", home))).toBe(false);
    expect(broken.calls.some((c) => c.argv[1] === "--bg")).toBe(false);
  });

  test("the project comes from hive's registry, deepest path first", async () => {
    const projects = join(process.env.HIVE_HOME!, "projects");
    const sub = join(repo, "apps", "web");
    await mkdir(sub, { recursive: true });
    for (const [name, path] of [["mono", repo], ["web", sub]] as const) {
      await mkdir(join(projects, name), { recursive: true });
      await writeFile(join(projects, name, "config.md"), `---\nname: ${name}\npath: ${path}\n---\n`);
    }
    expect(projectForDir(join(sub, "src"))).toBe("web");
    expect(projectForDir(join(repo, "docs"))).toBe("mono");
    expect(projectForDir(root)).toBeNull();

    const claude = fakeClaude();
    const { session } = await startAgent({ name: "web", charter: "c", cwd: sub, home, claudeBin: "claude", run: claude.run, wait: noWait });
    expect(session.project).toBe("web");
  });

  test("a cwd under ~ is expanded", async () => {
    const claude = fakeClaude();
    const savedHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const { session } = await startAgent({
        name: "tilde", charter: "c", cwd: "~/repo", home, claudeBin: "claude", run: claude.run, wait: noWait,
      });
      expect(session.cwd).toBe(repo);
    } finally {
      process.env.HOME = savedHome;
    }
  });

  test("agent names are constrained", () => {
    expect(validateAgentName("rate-limiter")).toBe("rate-limiter");
    for (const bad of ["Maya", "1st", "a b", "../x", "greg", ""]) {
      expect(() => validateAgentName(bad)).toThrow();
    }
  });
});

describe("claude adapter", () => {
  test("parses the --bg confirmation line", () => {
    expect(parseBackgrounded("Starting background service…\nbackgrounded · 17e458d3 · hv-spike3\n")).toBe("17e458d3");
    expect(parseBackgrounded("Workspace not trusted.")).toBeNull();
  });

  test("child env drops the API key and marks identity as injected", () => {
    const env = childEnv({ ANTHROPIC_API_KEY: "k", PATH: "/bin", HIVE_IDENTITY_IN_PROMPT: undefined });
    expect(env).toEqual({ PATH: "/bin", HIVE_IDENTITY_IN_PROMPT: "1" });
  });

  test("resume wins over worktree", () => {
    const argv = buildStartArgv("claude", {
      name: "a", cwd: "/r", systemPromptFile: "/s", mcpConfigFile: "/m", prompt: "p",
      permissionMode: "auto", resume: "sid", worktree: true,
    });
    expect(argv).toContain("--resume");
    expect(argv).not.toContain("-w");
  });
});

describe("agentPreamble", () => {
  test("maya keeps the hive identity's name; others are told the name is Maya's", () => {
    const maya = agentPreamble({ name: "maya", dir: "/w", parent: "greg" });
    expect(maya).toContain('You are Maya, as the identity above says, running as the comb agent "maya".');
    const other = agentPreamble({ name: "acme-api", dir: "/w", parent: "maya" });
    expect(other).toContain("Its name and role are Maya's.");
    expect(other).toContain('Your parent is the agent "maya".');
  });

  test("every agent is told it has one job, takes follow-ups, and stays off Greg's sessions", () => {
    const p = agentPreamble({ name: "acme-api-tk109", dir: "/w", parent: "maya", user: { name: "Greg", Name: "Greg" } });
    expect(p).toContain("with one job: your charter");
    expect(p).toContain("follow-ups and corrections come back to you");
    expect(p).toContain("Greg's own sessions (interactive, in `claude agents`) are outside the tree.");
  });

  test("with hive (Greg's install), the hive lines are all there", () => {
    const p = agentPreamble({ name: "acme-api", dir: "/w", parent: "greg", user: { name: "Greg", Name: "Greg" }, hive: true });
    expect(p).toContain("The identity above is the hive's shared voice and standards.");
    expect(p).toContain("(TRUST.md), cannot be undone, or sets direction Greg has not set");
    expect(p).toContain("Council needs Greg's yes.");
    expect(p).toContain("goes to hive with\n  `write_hive_memory`.");
    expect(p).toContain("Tickets and memory are shared through the hive\nMCP tools.");
    expect(p).toContain("external actions follow TRUST.md: ask through your parent.");
    expect(p).toContain("Your parent is Greg. Greg reads your reports and log");
  });

  test("without hive, nothing names hive, TRUST.md or council, and an unnamed user is 'the user'", () => {
    const p = agentPreamble({ name: "acme-api", dir: "/w", parent: "greg", hive: false });
    expect(p).not.toMatch(/hive|TRUST\.md|[Cc]ouncil|Greg/);
    expect(p).toContain("The identity above is the team's shared voice and standards.");
    expect(p).toContain("when the step is external\n  (push, deploy, send, post, spend)");
    expect(p).toContain("goes in the repo's docs\n  or your report.");
    expect(p).toContain("Your parent is the user. The user reads your reports and log");
    expect(p).toContain("The user's own sessions (interactive");
  });
});

describe("without hive", () => {
  let root: string;
  let home: string;
  let repo: string;
  const off: HiveSetup = { enabled: false, mode: "auto", bin: "hive", home: "/nonexistent-hive", why: "test" };

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "comb-nohive-")));
    home = join(root, "comb");
    repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    process.env.COMB_MCP_BIN = "/bin/comb-mcp-test";
  });
  afterEach(async () => {
    delete process.env.COMB_MCP_BIN;
    await rm(root, { recursive: true, force: true });
  });

  const start = (claude: ReturnType<typeof fakeClaude>, name = "notes") =>
    startAgent({ name, charter: "c", cwd: repo, home, claudeBin: "claude", run: claude.run, wait: noWait, hive: off });

  test("an agent starts on comb's default identity: hive is never run, and there is no project", async () => {
    const claude = fakeClaude();
    const { session, dir } = await start(claude);
    expect(claude.calls.some((c) => c.argv[0] === "hive" || c.argv[1] === "identity")).toBe(false);
    expect(session.project).toBeNull();
    const prompt = await readFile(join(dir, "system-prompt.md"), "utf-8");
    expect(prompt.startsWith("# Identity\n\nYou are Maya, chief of staff for the user's agents.")).toBe(true);
    expect(prompt).not.toContain("{{");
    expect(prompt).toContain("Your parent is the user.");
  });

  test("the identity names the configured user", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify({ userName: "Ada" }));
    const { dir } = await start(fakeClaude());
    const prompt = await readFile(join(dir, "system-prompt.md"), "utf-8");
    expect(prompt).toContain("chief of staff for Ada's agents");
    expect(prompt).toContain("Your parent is Ada. Ada reads your reports");
  });

  test("~/.comb/identity.md replaces the default, and identityFile replaces both", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "identity.md"), "# Mine\n");
    expect((await readFile(join((await start(fakeClaude(), "one")).dir, "system-prompt.md"), "utf-8")).startsWith("# Mine\n")).toBe(true);
    const other = join(root, "elsewhere.md");
    await writeFile(other, "# Elsewhere\n");
    await writeFile(join(home, "config.json"), JSON.stringify({ identityFile: other }));
    expect((await readFile(join((await start(fakeClaude(), "two")).dir, "system-prompt.md"), "utf-8")).startsWith("# Elsewhere\n")).toBe(true);
  });

  test("a missing identityFile fails the start and leaves nothing behind", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify({ identityFile: join(root, "missing.md") }));
    await expect(start(fakeClaude())).rejects.toThrow("which does not exist");
    expect(existsSync(agentDir("notes", home))).toBe(false);
  });

  test("a page message is signed with the configured name, and 'The user' without one", async () => {
    const claude = fakeClaude();
    await start(claude); // the fake lists it as live and working, so the page's message goes by relay
    await sendToAgent({ name: "notes", message: "hi", fromPage: true, home, claudeBin: "claude", run: claude.run, wait: noWait });
    expect(claude.calls.filter((c) => c.argv[1] === "-p").at(-1)!.stdin).toContain("The user, on the comb page:\n(The user reads your answer");
  });
});
