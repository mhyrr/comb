#!/usr/bin/env bun
/**
 * comb: agents that work on Greg's projects, layered on hive.
 * hive is who you are and what you know; comb is who is working on what.
 */
import { readFile } from "node:fs/promises";

import { formatAgentList, listAgents, sendToAgent, startAgent } from "./agents";
import { UsageError } from "./errors";
import { combInit } from "./init";

const usage = `comb: agents that work on your projects, layered on hive.

Usage:
  comb init                      Create ~/.comb and Maya's workspace; link comb-handoff
  comb start <name> --charter "<text>" [--cwd DIR] [--worktree] [--prompt "<text>"]
  comb start <name> --charter-file PATH [...]
  comb list                      The roster: each agent, working or ready, what it is for
  comb send <name> "<message>"   Message an agent; an asleep one wakes with it

Agents are Claude Code background sessions. Watch one with: claude attach <id>
From a Claude session, use the comb MCP tools: agent_list, agent_send, agent_start.`;

async function main(args: string[]): Promise<void> {
  const [cmd, ...rest] = args;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(usage);
    return;
  }
  if (cmd === "init") {
    for (const line of (await combInit()).lines) console.log(line);
    return;
  }
  if (cmd === "list") {
    console.log(formatAgentList(await listAgents()));
    return;
  }
  if (cmd === "send") {
    const [name, ...words] = rest;
    if (!name || words.length === 0) throw new UsageError(usage);
    const { woke } = await sendToAgent({ name, message: words.join(" ") });
    console.log(woke ? `${name} was asleep and is waking with the message.` : `Delivered to ${name}.`);
    return;
  }
  if (cmd === "start") {
    const { session, restarted, dir } = await startAgent(await parseStart(rest));
    console.log(`${restarted ? "Restarted" : "Started"} ${session.name} (session ${session.id}) in ${session.cwd}`);
    console.log(`Workspace: ${dir}`);
    console.log(`Watch it: claude attach ${session.id}`);
    return;
  }
  throw new UsageError(`Unknown command: ${cmd}\n\n${usage}`);
}

async function parseStart(args: string[]) {
  const name = args[0];
  if (!name || name.startsWith("-")) throw new UsageError(usage);
  const opts: { name: string; charter?: string; cwd?: string; worktree?: boolean; prompt?: string } = { name };
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    const value = () => {
      const v = args[++i];
      if (v === undefined) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    if (flag === "--charter") opts.charter = value();
    else if (flag === "--charter-file") opts.charter = await readFile(value(), "utf-8");
    else if (flag === "--cwd") opts.cwd = value();
    else if (flag === "--prompt") opts.prompt = value();
    else if (flag === "--worktree") opts.worktree = true;
    else throw new UsageError(`Unknown flag: ${flag}\n\n${usage}`);
  }
  return opts;
}

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof UsageError) {
    console.error(err.message);
    process.exit(2);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
