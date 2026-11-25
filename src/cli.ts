#!/usr/bin/env bun
/**
 * comb: a supervision tree of Claude Code background agents. Best with hive
 * (who you are and what you know); comb is who is working on what (D24).
 */
import { readFile } from "node:fs/promises";

import { formatAgentList, listAgents, sendToAgent, startAgent } from "./agents";
import { UsageError } from "./errors";
import { combInit, runInitSteps } from "./init";
import { detectHive, HIVE_URL, HiveClient, listHiveProjects } from "./hive";
import { formatNightly, NIGHTLY_EVERY_MS, NIGHTLY_FROM, runNightly } from "./nightly";
import { startPage } from "./page/server";
import { installPageService, PAGE_PORT } from "./page/service";
import { resolveCombHome } from "./paths";
import { addItem, formatSyncReport, syncAllPrecedents, withdrawItem, type NewItem } from "./queue";
import { claudeSettingsPath, installStatusLine, runTee, statusLineStatus, undoStatusLine } from "./statusline";

const usage = `comb: Claude Code background agents with one job each, a live page and a queue.
Best with hive (${HIVE_URL}) for identity, memory, tickets and nightly picks.

Usage:
  comb init                      Create ~/.comb and Maya's workspace; link comb-handoff;
                                 install (or reload) the service that keeps the page up;
                                 offer the status-line tee that feeds the page's limit bars
  comb init --install-statusline Install the tee without asking: statusLine.command in
                                 ~/.claude/settings.json becomes \`comb statusline\`
  comb init --undo-statusline    Put back the status line the tee replaced
  comb statusline                What Claude Code's status line runs once the tee is in:
                                 saves rate_limits to ~/.comb/cache, then runs the old command
  comb start <name> --charter "<text>" [--cwd DIR] [--worktree] [--model M] [--prompt "<text>"]
  comb start <name> --charter-file PATH [...]
  comb start <name> [--fresh]    Restart an agent from its workspace; --fresh starts a new
                                 conversation instead of resuming (after a comb upgrade)
  comb list                      The roster: each agent, working or ready, what it is for
  comb send <name> "<message>"   Message an agent; an asleep one wakes with it
  comb page                      Open comb's page (http://127.0.0.1:4747). It runs as a
                                 login service; if it is not up, this serves it until stopped
  comb page --serve [--port N]   Serve only (what the service runs). With hive, it also files hive's
                                 nightly picks into the queue, hourly
  comb nightly [--dry-run]       With hive: file hive's new Act picks into the queue now (briefing asks
                                 too if config.json sets nightlyAsks), after withdrawing open cards
                                 whose ticket is closed, taken or already done on a branch;
                                 --dry-run prints what it would withdraw and file, and why it skips
  comb queue add --kind K --title "<t>" --action "<a>" [--changes "<c>"] [--why "<case>"]
                [--project P] [--ticket T] [--model M] [--model-why "<w>"] [--on-no "<n>"] [--on-redirect "<r>"]
                                 File a queue item, as queue_add does. A proposal needs --changes:
                                 what changes for you on go, from your side of the screen
  comb queue withdraw <id> "<reason>"
                                 Take an open queue item away without an answer: its work is done
                                 or was taken elsewhere. Nothing reaches hive as a precedent
  comb precedents sync [--dry-run]
                                 With hive: queue each precedent not yet in hive memory as a
                                 decision candidate (Greg's answers save there as he gives them;
                                 this backfills and retries failures). --dry-run prints the entries

Agents are Claude Code background sessions. Watch one with: claude attach <id>
From a Claude session, use the comb MCP tools: agent_list, agent_send, agent_start.`;

async function main(args: string[]): Promise<void> {
  const [cmd, ...rest] = args;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(usage);
    return;
  }
  if (cmd === "statusline") {
    // Claude Code's statusLine command (D28). Kept lean: it runs on every assistant message.
    const result = await runTee(new Uint8Array(await Bun.stdin.arrayBuffer()), { home: resolveCombHome() });
    if (result.stdout.length) process.stdout.write(result.stdout);
    if (result.stderr.length) process.stderr.write(result.stderr);
    process.exitCode = result.code;
    return;
  }
  if (cmd === "init") {
    const install = rest.includes("--install-statusline");
    const undo = rest.includes("--undo-statusline");
    const unknown = rest.find((a) => a !== "--install-statusline" && a !== "--undo-statusline");
    if (unknown || (install && undo)) throw new UsageError(`${unknown ? `Unknown flag: ${unknown}` : "Pick one of --install-statusline and --undo-statusline."}\n\n${usage}`);
    const home = resolveCombHome();
    if (undo) {
      console.log((await undoStatusLine({ home })).message);
      return;
    }
    // Each step runs whatever the one before did (D28): a failed page reload never skips the status line.
    await runInitSteps([
      { label: "init", run: async () => (await combInit()).lines },
      { label: "page service", run: () => installPageService({ home }) },
      { label: "statusline", run: () => offerStatusLine(home, install) },
    ], (line) => console.log(line));
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
  if (cmd === "nightly") {
    const dryRun = rest.includes("--dry-run");
    const unknown = rest.find((a) => a !== "--dry-run");
    if (unknown) throw new UsageError(`Unknown flag: ${unknown}\n\n${usage}`);
    const hive = detectHive();
    if (!hive.enabled) {
      console.log(`hive is off (${hive.why}), so there are no nightly picks to file. Install hive: ${HIVE_URL}`);
      return;
    }
    console.log(formatNightly(await runNightly({ dryRun, hiveHome: hive.home, notify: (message) => sendToAgent({ name: NIGHTLY_FROM, message }) })));
    return;
  }
  if (cmd === "queue") {
    if (rest[0] === "add") {
      const item = await addItem(parseQueueAdd(rest.slice(1)));
      console.log(`Filed ${item.id}. The answer will go to "${item.from}" as a message.`);
      return;
    }
    const [sub, id, ...words] = rest;
    if (sub !== "withdraw" || !id || words.length === 0) throw new UsageError(usage);
    const item = await withdrawItem(id, words.join(" "), process.env.COMB_AGENT || "cli");
    console.log(`Withdrew ${item.id}: ${item.withdrawnWhy}`);
    return;
  }
  if (cmd === "precedents") {
    const [sub, ...flags] = rest;
    const dryRun = flags.includes("--dry-run");
    const unknown = flags.find((a) => a !== "--dry-run");
    if (sub !== "sync" || unknown) throw new UsageError(`${unknown ? `Unknown flag: ${unknown}\n\n` : ""}${usage}`);
    const hive = detectHive();
    if (!hive.enabled) {
      console.log(`hive is off (${hive.why}), so precedents stay in ~/.comb/precedents. Install hive: ${HIVE_URL}`);
      return;
    }
    const client = new HiveClient();
    try {
      const report = await syncAllPrecedents({ writer: client, projects: listHiveProjects(hive.home) }, { dryRun });
      console.log(formatSyncReport(report, dryRun));
      if (report.failed.length) process.exitCode = 1;
    } finally {
      await client.close();
    }
    return;
  }
  if (cmd === "page") {
    let port = PAGE_PORT;
    let serveOnly = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--port") port = Number(rest[++i]);
      else if (rest[i] === "--serve") serveOnly = true;
      else throw new UsageError(`Unknown flag: ${rest[i]}\n\n${usage}`);
    }
    if (!Number.isInteger(port)) throw new UsageError("--port needs a number");
    const url = `http://127.0.0.1:${port}`;
    const open = () => { if (process.platform === "darwin") Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" }); };
    if (!serveOnly && (await pageIsUp(url))) {
      console.log(`comb's page is at ${url}`);
      open();
      return;
    }
    startPage({ port, nightlyMs: NIGHTLY_EVERY_MS, pullsMs: 60_000 });
    console.log(`${new Date().toISOString()} comb's page is serving at ${url}`);
    if (!serveOnly) open();
    await new Promise(() => {}); // serve until stopped
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

/**
 * The status-line tee is never installed silently: --install-statusline is the
 * yes, a terminal is asked, and anything else only hears how to install it.
 */
async function offerStatusLine(home: string, yes: boolean): Promise<string> {
  const status = await statusLineStatus(claudeSettingsPath(), home);
  if (status.installed) return `statusline: comb's tee is installed (${status.command}). Undo: comb init --undo-statusline`;
  const what = `comb can show your plan limits (session and weekly) on its page. To get them, it runs your status line through \`comb statusline\`, which saves the limits and then runs ${status.command ? `your current status line ("${status.command}")` : "nothing else (you have no status line)"}. This changes statusLine.command in ${claudeSettingsPath()}; the old value is kept, and comb init --undo-statusline restores it.`;
  if (!yes) {
    if (!process.stdin.isTTY) return `statusline: not installed. ${what} Install: comb init --install-statusline`;
    const answer = prompt(`\n${what}\nInstall it? [y/N]`);
    if (!/^y(es)?$/i.test(answer?.trim() ?? "")) return "statusline: not installed. Install later with: comb init --install-statusline";
  }
  return (await installStatusLine({ home })).message;
}

/** Whether comb's page already answers at `url`. */
async function pageIsUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/projects`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false; // intentional: nothing listening
  }
}

/** `comb queue add`'s flags, named as queue_add's fields. The filer is $COMB_AGENT, else "cli". */
function parseQueueAdd(args: string[], from = process.env.COMB_AGENT || "cli"): NewItem {
  const flags: Record<string, keyof NewItem> = {
    "--kind": "kind", "--title": "title", "--action": "action", "--changes": "changes", "--why": "body",
    "--project": "project", "--ticket": "ticket", "--model": "model", "--model-why": "modelWhy",
    "--on-no": "onNo", "--on-redirect": "onRedirect",
  };
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    const field = flags[flag];
    if (!field) throw new UsageError(`Unknown flag: ${flag}\n\n${usage}`);
    const v = args[++i];
    if (v === undefined) throw new UsageError(`${flag} needs a value`);
    out[field] = v;
  }
  if (!out.kind) throw new UsageError(`--kind is required\n\n${usage}`);
  return { title: "", action: "", ...out, kind: out.kind, from };
}

async function parseStart(args: string[]) {
  const name = args[0];
  if (!name || name.startsWith("-")) throw new UsageError(usage);
  const opts: { name: string; charter?: string; cwd?: string; worktree?: boolean; prompt?: string; model?: string; fresh?: boolean } = { name };
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
    else if (flag === "--model") opts.model = value();
    else if (flag === "--fresh") opts.fresh = true;
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
