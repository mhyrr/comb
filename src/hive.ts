/**
 * comb's only contact with hive. hive is the personalization layer (identity,
 * memory, taste, tickets). comb works without it (D24); when `detectHive`
 * finds it, comb reads it through stable interfaces and never writes ~/.hive:
 *   - identity:  `hive identity emit`, run in the agent's directory
 *   - projects:  the registry files ~/.hive/projects/<name>/config.md
 *   - memory and tickets: the `hive` MCP server every Claude session loads
 *     (read, plus one write: queue precedents go to write_hive_memory as
 *     candidates, which hive's nightly verifier admits; D13)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

import { runProcess, type Run } from "./claude";
import { readCombConfig, type HiveMode } from "./config";

export function resolveHiveHome(): string {
  return process.env.HIVE_HOME || join(homedir(), ".hive");
}

/** Where to get hive, for the "install hive" notes in comb init and on the page. */
export const HIVE_URL = "https://github.com/mhyrr/hive";

export function findHiveBin(): string {
  return process.env.COMB_HIVE_BIN || "hive";
}

/**
 * Whether comb uses hive (D24). With hive, comb works as it always has:
 * identity from `hive identity emit`, project names from the registry,
 * tickets and memory on the page, and hive's nightly in the queue. Without
 * it, comb runs on plain Claude Code.
 */
export type HiveSetup = {
  enabled: boolean;
  mode: HiveMode;
  /** The command to run: "hive" when it is on PATH, so the argv is what it always was. */
  bin: string;
  home: string;
  /** One line on why, for `comb init` and the page log. */
  why: string;
};

/**
 * Finds the hive CLI: COMB_HIVE_BIN, then "hive" on PATH, then
 * ~/.local/bin/hive (launchd's PATH rarely holds it). Null when none.
 */
export function locateHive(exists: (p: string) => boolean = existsSync): string | null {
  if (process.env.COMB_HIVE_BIN) return process.env.COMB_HIVE_BIN;
  if (Bun.which("hive")) return "hive";
  const local = join(process.env.HOME || homedir(), ".local", "bin", "hive");
  return exists(local) ? local : null;
}

/**
 * Decides once per process whether hive is on. "auto" (the default) needs
 * both the CLI and hive's home (~/.hive); "on" requires hive, so a missing
 * one fails loudly at the next start as it always did; "off" never uses it.
 */
export function detectHive(o: {
  mode?: HiveMode;
  hiveHome?: string;
  locate?: () => string | null;
  exists?: (p: string) => boolean;
} = {}): HiveSetup {
  const mode = o.mode ?? readCombConfig().hive;
  const home = o.hiveHome ?? resolveHiveHome();
  const exists = o.exists ?? existsSync;
  const found = (o.locate ?? (() => locateHive(exists)))();
  if (mode === "off") return { enabled: false, mode, bin: found ?? "hive", home, why: "set to off in config.json or COMB_HIVE" };
  if (mode === "on") return { enabled: true, mode, bin: found ?? "hive", home, why: "set to on in config.json or COMB_HIVE" };
  if (!found) return { enabled: false, mode, bin: "hive", home, why: "no hive CLI on PATH or in ~/.local/bin" };
  if (!exists(home)) return { enabled: false, mode, bin: found, home, why: `found ${found}, but ${home} does not exist` };
  return { enabled: true, mode, bin: found, home, why: `found ${found} and ${home}` };
}

/** HIVE identity for a session in `cwd`: soul, the user, project memory, taste. */
export async function hiveIdentity(cwd: string, run: Run = runProcess, bin: string = findHiveBin()): Promise<string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  let res;
  try {
    res = await run([bin, "identity", "emit"], { cwd, env });
  } catch (err) {
    throw new Error(`Could not run hive identity emit: ${err instanceof Error ? err.message : String(err)}. Is hive installed?`);
  }
  if (res.code !== 0 || !res.stdout.trim()) {
    throw new Error(`hive identity emit failed (exit ${res.code}): ${res.stderr.trim()}`);
  }
  return res.stdout;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path; // intentional: a missing path simply matches nothing
  }
}

/** The registered hive project whose path holds `dir`; the deepest match wins. */
export function projectForDir(dir: string, hiveHome: string = resolveHiveHome()): string | null {
  const projectsDir = join(hiveHome, "projects");
  if (!existsSync(projectsDir)) return null;
  const target = canonical(dir);
  let best: { name: string; len: number } | null = null;
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let raw: string;
    try {
      raw = readFileSync(join(projectsDir, entry.name, "config.md"), "utf-8");
    } catch {
      continue; // intentional: a project without a readable config is skipped
    }
    const m = raw.match(/^path:\s*(.+)$/m);
    if (!m) continue;
    const base = canonical(m[1]!.trim().replace(/^["']|["']$/g, "").replace(/^~(?=\/)/, homedir()));
    const inside = target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
    if (inside && (!best || base.length > best.len)) best = { name: entry.name, len: base.length };
  }
  return best?.name ?? null;
}

// ---------------------------------------------------------------------------
// Tickets and memory, through the hive MCP server (read-only, for the page).


export type Ticket = {
  project: string;
  id: string;
  status: "open" | "in_progress" | "closed";
  priority: number;
  type: string;
  title: string;
  tags: string[];
  blockedBy: string[];
};

/** Parses one line of hive's list_tickets output. */
export function parseTicketLine(project: string, line: string): Ticket | null {
  const m = line.match(/^(\S+)\s{2}(open|in_progress|closed)\s+P(\d|\?)-\S+\s+(\S+)\s{2}(.*)$/);
  if (!m) return null;
  let rest = m[5]!.trim();
  let blockedBy: string[] = [];
  const dep = rest.match(/\s*\(blocked by: ([^)]*)\)$/);
  if (dep) {
    blockedBy = dep[1]!.split(",").map((s) => s.trim()).filter(Boolean);
    rest = rest.slice(0, dep.index).trim();
  }
  let tags: string[] = [];
  const tg = rest.match(/\s*\[([^\]]*)\]$/);
  if (tg) {
    tags = tg[1]!.split(",").map((s) => s.trim()).filter(Boolean);
    rest = rest.slice(0, tg.index).trim();
  }
  return {
    project,
    id: m[1]!,
    status: m[2] as Ticket["status"],
    priority: m[3] === "?" ? 9 : Number(m[3]),
    type: m[4]!,
    title: rest,
    tags,
    blockedBy,
  };
}

/**
 * Each registered project with the `path:` its config.md names (~ expanded).
 * A project without a readable config or a path is left out.
 */
export function hiveProjectPaths(hiveHome: string = resolveHiveHome()): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  for (const name of listHiveProjects(hiveHome)) {
    let raw: string;
    try {
      raw = readFileSync(join(hiveHome, "projects", name, "config.md"), "utf-8");
    } catch {
      continue; // intentional: an unreadable config names no path
    }
    const m = raw.match(/^path:\s*(.+)$/m);
    if (!m) continue;
    out.push({ name, path: m[1]!.trim().replace(/^["']|["']$/g, "").replace(/^~(?=\/)/, homedir()) });
  }
  return out;
}

/** Registered hive projects, from the registry folder. */
export function listHiveProjects(hiveHome: string = resolveHiveHome()): string[] {
  const dir = join(hiveHome, "projects");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "config.md")))
    .map((e) => e.name)
    .sort();
}

/**
 * How Greg's Claude sessions start the hive MCP server: the user-scope entry
 * in ~/.claude.json (read, never written). COMB_HIVE_MCP overrides it with a
 * command line.
 */
export function hiveMcpCommand(): { command: string; args: string[]; env?: Record<string, string> } {
  if (process.env.COMB_HIVE_MCP) {
    const [command, ...args] = process.env.COMB_HIVE_MCP.split(" ").filter(Boolean);
    return { command: command!, args };
  }
  const path = join(homedir(), ".claude.json");
  try {
    const entry = JSON.parse(readFileSync(path, "utf-8"))?.mcpServers?.hive;
    if (entry?.command) return { command: entry.command, args: entry.args ?? [], env: entry.env };
  } catch {
    // intentional: fall through to the clear error below
  }
  throw new Error(`No hive MCP server in ${path}. Set COMB_HIVE_MCP to the command that starts it.`);
}

/** A long-lived client of the hive MCP server. Reconnects after a failure. */
export class HiveClient {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const { command, args, env } = hiveMcpCommand();
        const base: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;
        const client = new Client({ name: "comb-page", version: "0.1.0" });
        const transport = new StdioClientTransport({ command, args, env: { ...base, ...env }, stderr: "ignore" });
        transport.onclose = () => { this.client = null; };
        await client.connect(transport);
        this.client = client;
        return client;
      })().finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    let client: Client;
    try {
      client = await this.connect();
    } catch (err) {
      throw new Error(`Could not start the hive MCP server: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const res = (await client.callTool({ name, arguments: args })) as { content?: { type: string; text?: string }[]; isError?: boolean };
      const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
      if (res.isError) throw new Error(text || `hive ${name} failed`);
      return text;
    } catch (err) {
      this.client = null; // a broken connection is rebuilt on the next call
      try { await client.close(); } catch { /* intentional: already closed */ }
      throw err;
    }
  }

  async tickets(project: string, status?: "open" | "in_progress" | "closed"): Promise<Ticket[]> {
    const text = await this.call("list_tickets", status ? { project, status } : { project });
    return text.split("\n").map((l) => parseTicketLine(project, l)).filter((t): t is Ticket => t !== null);
  }

  showTicket(project: string, id: string): Promise<string> {
    return this.call("show_ticket", { project, id });
  }

  async memory(project: string): Promise<MemoryEntry[]> {
    return parseMemory(await this.call("read_hive_memory", { project, include_superseded: false }));
  }

  /**
   * Queues a memory candidate through hive's own write path (write_hive_memory).
   * hive's nightly verifier admits it to canon; comb never writes ~/.hive.
   */
  writeMemory(c: MemoryCandidate): Promise<string> {
    return this.call("write_hive_memory", {
      project: c.project,
      type: c.type,
      content: c.content,
      tags: c.tags,
      ...(c.provenanceNote ? { provenance_note: c.provenanceNote } : {}),
      ...(c.directive ? { directive: true } : {}),
    });
  }

  async close(): Promise<void> {
    try { await this.client?.close(); } catch { /* intentional: already closed */ }
    this.client = null;
  }
}

/** One write_hive_memory call. `directive` means Greg himself made the call, so the verifier may not reject it. */
export type MemoryCandidate = {
  project: string;
  type: "fact" | "convention" | "decision" | "question";
  content: string;
  tags: string[];
  provenanceNote?: string;
  directive?: boolean;
};

/** What comb needs to write hive memory; HiveClient in use, a fake in tests. */
export type MemoryWriter = { writeMemory(c: MemoryCandidate): Promise<string> };

export type MemorySection = "facts" | "conventions" | "decisions" | "questions";
export type MemoryEntry = { section: MemorySection; date: string | null; text: string; tags: string[] };

const SECTION_OF: Record<string, MemorySection> = {
  "durable facts": "facts",
  facts: "facts",
  conventions: "conventions",
  decisions: "decisions",
  "open questions": "questions",
  questions: "questions",
};

/**
 * Parses hive's read_hive_memory output (one "- " entry per line under
 * "## <Section>") into entries. Drops the provenance trail; keeps the date
 * prefix and trailing tags as fields.
 */
export function parseMemory(text: string): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  let section: MemorySection | null = null;
  for (const raw of text.split("\n")) {
    const head = raw.match(/^##\s+(.+?)\s*$/);
    if (head) {
      section = SECTION_OF[head[1]!.toLowerCase()] ?? null;
      continue;
    }
    if (!section) continue;
    if (!raw.startsWith("- ")) {
      // A wrapped continuation belongs to the entry above it.
      const last = out.at(-1);
      if (last && raw.trim() && /^\s/.test(raw)) last.text += " " + raw.trim();
      continue;
    }
    let body = raw.slice(2).trim();
    const prov = body.search(/\s_provenance:_/);
    if (prov >= 0) body = body.slice(0, prov).trim();
    let date: string | null = null;
    const d = body.match(/^\[(\d{4}-\d\d-\d\d)\]\s*/);
    if (d) {
      date = d[1]!;
      body = body.slice(d[0].length);
    }
    let tags: string[] = [];
    const t = body.match(/\s\[([^\]]*)\]\s*(\[[^\]]*\])?\s*$/);
    if (t) {
      tags = t[1]!.split(",").map((s) => s.trim()).filter(Boolean);
      body = body.slice(0, t.index).trim();
    }
    out.push({ section, date, text: body, tags });
  }
  return out;
}

// ---------------------------------------------------------------------------
// hive's nightly outputs, read for comb's queue (design §9.3). Read-only files:
//   ~/.hive/next.json                      the Act watches' picks, one per project
//   ~/.hive/briefings/<date>.md            the briefing and its attention list
//   ~/.hive/projects/<p>/tickets/<id>.md   a ticket's status and title

export type ActPick = { project: string; ticket: string; rationale: string; selectedAt: string; source: string };

/** The recommended Act picks in next.json. A missing or half-written file reads as none. */
export function readActPicks(hiveHome: string = resolveHiveHome()): ActPick[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(hiveHome, "next.json"), "utf-8"));
  } catch {
    return []; // intentional: no file yet, or hive is mid-write; the next run reads it
  }
  const selections = (raw as { selections?: unknown } | null)?.selections;
  if (!Array.isArray(selections)) return [];
  const out: ActPick[] = [];
  for (const s of selections as Record<string, unknown>[]) {
    if (s?.disposition !== "recommended") continue;
    const { projectId, ticketId, rationale, selectedAt, sourceWatch } = s;
    if (typeof projectId !== "string" || typeof ticketId !== "string" || typeof selectedAt !== "string") continue;
    if (Number.isNaN(Date.parse(selectedAt))) continue;
    out.push({
      project: projectId,
      ticket: ticketId,
      rationale: typeof rationale === "string" ? rationale : "",
      selectedAt,
      source: typeof sourceWatch === "string" ? sourceWatch : `${projectId}/act`,
    });
  }
  return out;
}

/** The briefing for `date` (YYYY-MM-DD), or null if hive has not written it. */
export function readBriefing(date: string, hiveHome: string = resolveHiveHome()): string | null {
  try {
    return readFileSync(join(hiveHome, "briefings", `${date}.md`), "utf-8");
  } catch {
    return null; // intentional: no briefing for that day
  }
}

/** The numbered items under "## What needs your attention", one string each. */
export function parseAttention(briefing: string): string[] {
  const lines = briefing.split("\n");
  const start = lines.findIndex((l) => /^##\s+What needs your attention\s*$/i.test(l));
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    const n = line.match(/^\d+\.\s+(.*)$/);
    if (n) items.push(n[1]!.trim());
    else if (line.trim() && /^\s/.test(line) && items.length) items[items.length - 1] += " " + line.trim();
  }
  return items.filter(Boolean);
}

/** `updated` is the front matter's ISO time, null when the file has none. */
export type TicketFile = { status: string; title: string; priority: string | null; type: string | null; updated: string | null };

/** A ticket's front matter from hive's ticket file, or null if hive has no such ticket. */
export function readTicketFile(project: string, id: string, hiveHome: string = resolveHiveHome()): TicketFile | null {
  if (!/^[\w.-]+$/.test(project) || project.startsWith(".") || !/^[\w-]+$/.test(id)) return null;
  let raw: string;
  try {
    raw = readFileSync(join(hiveHome, "projects", project, "tickets", `${id}.md`), "utf-8");
  } catch {
    return null; // intentional: no such ticket
  }
  const head = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const field = (k: string) => head.match(new RegExp(`^${k}:\\s*(.*)$`, "m"))?.[1]?.trim() || null;
  return { status: field("status") ?? "open", title: field("title") ?? "", priority: field("priority"), type: field("type"), updated: field("updated") };
}
