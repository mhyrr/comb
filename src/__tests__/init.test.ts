import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { combInit } from "../init";
import { startAgent } from "../agents";
import type { Run } from "../claude";

let root: string;
let opts: { home: string; repo: string; claudeSkillsDir: string };

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "comb-init-")));
  const repo = join(root, "repo");
  await mkdir(join(repo, "skills", "comb-handoff"), { recursive: true });
  await writeFile(join(repo, "skills", "comb-handoff", "SKILL.md"), "---\nname: comb-handoff\n---\n");
  await mkdir(join(repo, "templates"), { recursive: true });
  await writeFile(join(repo, "templates", "maya-charter.md"), "# Maya\n");
  opts = { home: join(root, "comb"), repo, claudeSkillsDir: join(root, "claude-skills") };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("init creates Maya's workspace and links comb-handoff into Claude's skills", async () => {
  await combInit(opts);
  expect(await readFile(join(opts.home, "agents", "maya", "charter.md"), "utf-8")).toBe("# Maya\n");
  expect(existsSync(join(opts.home, "agents", "maya", "log.md"))).toBe(true);
  const link = join(opts.claudeSkillsDir, "comb-handoff");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readlinkSync(link)).toBe(join(opts.repo, "skills", "comb-handoff"));
});

test("init runs twice without changing anything, and never overwrites", async () => {
  await combInit(opts);
  await writeFile(join(opts.home, "agents", "maya", "charter.md"), "# Maya, edited by Greg\n");
  const again = await combInit(opts);
  expect(again.lines).toContain("skill comb-handoff: already linked");
  expect(await readFile(join(opts.home, "agents", "maya", "charter.md"), "utf-8")).toBe("# Maya, edited by Greg\n");

  await rm(join(opts.claudeSkillsDir, "comb-handoff"));
  await mkdir(join(opts.claudeSkillsDir, "comb-handoff"));
  const other = await combInit(opts);
  expect(other.lines.some((l) => l.includes("not comb's link; left as is"))).toBe(true);
  expect(lstatSync(join(opts.claudeSkillsDir, "comb-handoff")).isDirectory()).toBe(true);
});

test("init refuses when the repo is not where it expects", async () => {
  await expect(combInit({ ...opts, repo: join(root, "nowhere") })).rejects.toThrow("COMB_REPO");
});

test("the first start of an init-made workspace is a start, not a restart", async () => {
  await combInit(opts);
  const sessions: object[] = [];
  const run: Run = async (argv, o) => {
    if (argv[1] === "identity") return { code: 0, stdout: "ID\n", stderr: "" };
    if (argv[1] === "agents") return { code: 0, stdout: JSON.stringify(sessions), stderr: "" };
    sessions.push({ id: "abc12345", sessionId: "abc12345-s", name: "maya", cwd: o.cwd, state: "working" });
    return { code: 0, stdout: "backgrounded · abc12345 · maya\n", stderr: "" };
  };
  process.env.COMB_MCP_BIN = "/bin/x";
  const res = await startAgent({ name: "maya", cwd: root, home: opts.home, claudeBin: "claude", run, wait: async () => {} });
  delete process.env.COMB_MCP_BIN;
  expect(res.restarted).toBe(false);
  const log = await readFile(join(opts.home, "agents", "maya", "log.md"), "utf-8");
  expect(log).toContain("started by greg");
});
