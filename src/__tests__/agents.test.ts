import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentDir, agentPreamble, listAgents, sendToAgent, startAgent, validateAgentName } from "../agents";
import { buildStartArgv, childEnv, parseBackgrounded, type LiveSession, type Run } from "../claude";
import { projectForDir } from "../hive";
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
  const run: Run = async (argv, opts) => {
    calls.push({ argv, cwd: opts.cwd, env: opts.env, stdin: opts.stdin });
    if (argv[1] === "-p") return { code: 0, stdout: `${relayReply}\n`, stderr: "" };
    if (argv[1] === "identity") return identity ?? { code: 0, stdout: `IDENTITY for ${opts.cwd}\n`, stderr: "" };
    if (argv[1] === "agents") return { code: 0, stdout: JSON.stringify(sessions), stderr: "" };
    if (argv[1] === "--bg") {
      const name = argv[argv.indexOf("-n") + 1]!;
      const resumeAt = argv.indexOf("--resume");
      const id = resumeAt >= 0 ? argv[resumeAt + 1]!.slice(0, 8) : `abc${String(next++).padStart(5, "0")}`;
      if (bgOutput) return bgOutput(id, name);
      const sessionId = resumeAt >= 0 ? argv[resumeAt + 1]! : `${id}-0000-0000-0000-000000000000`;
      const at = sessions.findIndex((s) => s.sessionId === sessionId);
      if (at >= 0) sessions.splice(at, 1);
      sessions.push({ id, sessionId, name, cwd: opts.cwd, state: "working" });
      return { code: 0, stdout: `backgrounded · ${id} · ${name}\n`, stderr: "" };
    }
    throw new Error(`unexpected claude call: ${argv.join(" ")}`);
  };
  return {
    run, calls, sessions,
    failBg: (f: typeof bgOutput) => { bgOutput = f; },
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
  });

  afterEach(async () => {
    if (saved.hive === undefined) delete process.env.HIVE_HOME; else process.env.HIVE_HOME = saved.hive;
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
    delete process.env.COMB_MCP_BIN;
    await rm(root, { recursive: true, force: true });
  });

  test("a new agent gets a workspace, a session record and a log line", async () => {
    const claude = fakeClaude();
    const { session, restarted, dir } = await startAgent({
      name: "revrec", charter: "Own the revrec project.", cwd: repo, home,
      claudeBin: "claude", run: claude.run, wait: noWait,
    });

    expect(restarted).toBe(false);
    expect(dir).toBe(agentDir("revrec", home));
    expect(await readFile(join(dir, "charter.md"), "utf-8")).toBe("Own the revrec project.\n");
    for (const f of ["checklist.md", "log.md", "system-prompt.md", "mcp.json", "session.json"]) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
    expect(existsSync(join(dir, "reports"))).toBe(true);
    expect(existsSync(join(dir, "memory"))).toBe(true);

    expect(session).toMatchObject({ name: "revrec", parent: "greg", cwd: repo, harness: "claude", permissionMode: "auto" });
    expect(JSON.parse(await readFile(join(dir, "session.json"), "utf-8")).sessionId).toBe(session.sessionId);
    expect(await readFile(join(dir, "log.md"), "utf-8")).toContain(`started by greg in ${repo} (session ${session.id})`);

    const prompt = await readFile(join(dir, "system-prompt.md"), "utf-8");
    expect(prompt.startsWith(`IDENTITY for ${repo}`)).toBe(true);
    expect(prompt).toContain('Here you are the comb agent "revrec", and your role is your charter.');
    expect(prompt).toContain("Decide and act when the step is reversible");
    expect(prompt).toContain("Your parent is Greg.");

    const mcp = JSON.parse(await readFile(join(dir, "mcp.json"), "utf-8"));
    expect(mcp.mcpServers.comb).toMatchObject({ command: "/bin/comb-mcp-test", env: { COMB_AGENT: "revrec", COMB_HOME: home } });
  });

  test("the session starts detached on the subscription, with identity in the prompt", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    const claude = fakeClaude();
    await startAgent({ name: "arete", charter: "c", cwd: repo, home, claudeBin: "claude", run: claude.run, wait: noWait });

    const bg = claude.calls.find((c) => c.argv[1] === "--bg")!;
    expect(bg.cwd).toBe(repo);
    expect(bg.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(bg.env.HIVE_IDENTITY_IN_PROMPT).toBe("1");
    const dir = agentDir("arete", home);
    expect(bg.argv).toEqual([
      "claude", "--bg", "--mcp-config", join(dir, "mcp.json"),
      "-n", "arete", "--permission-mode", "auto",
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

  test("with no model set, no --model flag is passed", async () => {
    const claude = fakeClaude();
    await startAgent({ name: "plain", charter: "c", cwd: repo, home, claudeBin: "claude", run: claude.run, wait: noWait });
    expect(claude.calls.find((c) => c.argv[1] === "--bg")!.argv).not.toContain("--model");
  });

  test("a child names its parent and how to reach it", async () => {
    const claude = fakeClaude();
    const { dir } = await startAgent({
      name: "rate-limiter", charter: "Build TK-142.", parent: "revrec", worktree: true, cwd: repo, home,
      claudeBin: "claude", run: claude.run, wait: noWait,
    });
    expect(await readFile(join(dir, "system-prompt.md"), "utf-8")).toContain('Your parent is the agent "revrec". Tell it with `agent_send`');
    const bg = claude.calls.find((c) => c.argv[1] === "--bg")!;
    expect(bg.argv.slice(-3)).toEqual(["-w", "rate-limiter", "Read your charter.md and checklist.md, then begin."]);
  });

  test("a new agent needs a charter; an existing one refuses a new charter", async () => {
    const claude = fakeClaude();
    const base = { cwd: repo, home, claudeBin: "claude", run: claude.run, wait: noWait };
    await expect(startAgent({ name: "writing", ...base })).rejects.toThrow("Give it a charter");
    await startAgent({ name: "writing", charter: "first", ...base });
    await expect(startAgent({ name: "writing", charter: "second", ...base })).rejects.toThrow("already exists");
    expect(await readFile(join(agentDir("writing", home), "charter.md"), "utf-8")).toBe("first\n");
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
    const first = await startAgent({ name: "investing", charter: "c", cwd: repo, ...base });
    claude.sessions[0]!.state = "done";

    const second = await startAgent({ name: "investing", ...base });
    expect(second.restarted).toBe(true);
    const bg = claude.calls.filter((c) => c.argv[1] === "--bg").at(-1)!;
    expect(bg.cwd).toBe(repo);
    expect(bg.argv).toContain("--resume");
    expect(bg.argv[bg.argv.indexOf("--resume") + 1]).toBe(first.session.sessionId);
    expect(bg.argv.at(-1)).toContain("You were restarted from your workspace.");
    expect(await readFile(join(agentDir("investing", home), "log.md"), "utf-8")).toContain("resumed by greg");
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
      name: "matreas", charter: "c", cwd: repo, home, claudeBin: "claude", run: claude.run, wait: noWait,
    })).rejects.toThrow("Claude has not trusted");
    // Nothing left behind, so the same start can be retried.
    expect(existsSync(agentDir("matreas", home))).toBe(false);
  });

  test("a session that fails at start is reported, not waited on", async () => {
    const claude = fakeClaude();
    claude.failBg((id, name) => {
      claude.sessions.push({ id, sessionId: `${id}-s`, name, cwd: repo, state: "failed" });
      return { code: 0, stdout: `backgrounded · ${id} · ${name}\n`, stderr: "" };
    });
    await expect(startAgent({
      name: "matreas", charter: "c", cwd: repo, home, claudeBin: "claude", run: claude.run, wait: noWait,
    })).rejects.toThrow("failed at start");
    expect(claude.calls.filter((c) => c.argv[1] === "agents" && c.argv.includes("--all"))).toHaveLength(1);
    expect(existsSync(agentDir("matreas", home))).toBe(false);
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
    const first = await startAgent({ name: "revrec", charter: "c", cwd: repo, parent: "maya", ...base });
    claude.sessions[0] = { ...claude.sessions[0]!, kind: "background", state: "blocked", status: undefined };

    const { woke, session } = await sendToAgent({ name: "revrec", message: "take TK-143", from: "maya", ...base });
    expect(woke).toBe(true);
    expect(session!.parent).toBe("maya");
    const bg = claude.calls.filter((c) => c.argv[1] === "--bg").at(-1)!;
    expect(bg.argv[bg.argv.indexOf("--resume") + 1]).toBe(first.session.sessionId);
    expect(bg.argv.at(-1)).toContain("take TK-143");
    expect(claude.calls.some((c) => c.argv[1] === "-p")).toBe(false);
  });

  test("send reaches a session that is not an agent, such as Greg's", async () => {
    const claude = fakeClaude([{ id: "x", sessionId: "s-1", name: "hive-e8", cwd: repo, kind: "interactive", status: "idle", pid: 42 }]);
    const { woke } = await sendToAgent({ name: "hive-e8", message: "done", from: "hive-a1", home, claudeBin: "claude", run: claude.run });
    expect(woke).toBe(false);
    expect(claude.calls.find((c) => c.argv[1] === "-p")!.stdin).toContain('to "hive-e8"');
  });

  test("an agent answers Greg's session that wrote to it, but never hands one work", async () => {
    const greg = { id: "x", sessionId: "s-g", name: "collegevalue-71", cwd: repo, kind: "interactive", status: "idle", pid: 42 };
    const claude = fakeClaude([greg]);
    const base = { home, claudeBin: "claude", run: claude.run, wait: noWait };
    await startAgent({ name: "maya", charter: "c", cwd: repo, ...base });
    const maya = claude.sessions.find((s) => s.name === "maya")!;
    Object.assign(maya, { kind: "background", state: "blocked", status: "idle" });

    // Cold: Maya may not route work into Greg's own session.
    await expect(sendToAgent({ name: "collegevalue-71", message: "drop the at-risk view", from: "maya", ...base }))
      .rejects.toThrow("one of Greg's own sessions, outside the tree");
    expect(claude.calls.some((c) => c.argv[1] === "-p")).toBe(false);

    // Once that session writes to Maya, she can answer it.
    await sendToAgent({ name: "maya", message: "what's waiting?", from: "collegevalue-71", ...base });
    await sendToAgent({ name: "collegevalue-71", message: "two things", from: "maya", ...base });
    expect(claude.calls.filter((c) => c.argv[1] === "-p").at(-1)!.stdin).toContain('to "collegevalue-71"');
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
      name: "writing", charter: "c", cwd: repo, home, claudeBin: "claude", run: broken.run, wait: noWait,
    })).rejects.toThrow("hive identity emit failed");
    expect(existsSync(agentDir("writing", home))).toBe(false);
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
    const other = agentPreamble({ name: "revrec", dir: "/w", parent: "maya" });
    expect(other).toContain("Its name and role are Maya's.");
    expect(other).toContain('Your parent is the agent "maya".');
  });

  test("every agent is told it has one job, takes follow-ups, and stays off Greg's sessions", () => {
    const p = agentPreamble({ name: "revrec-tk109", dir: "/w", parent: "maya" });
    expect(p).toContain("with one job: your charter");
    expect(p).toContain("follow-ups and corrections come back to you");
    expect(p).toContain("Greg's own sessions (interactive, in `claude agents`) are outside the tree.");
  });
});
