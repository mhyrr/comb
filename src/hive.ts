/**
 * comb's only contact with hive. hive is the personalization layer (identity,
 * memory, taste, tickets); comb reads it through stable interfaces and never
 * writes to ~/.hive:
 *   - identity:  `hive identity emit`, run in the agent's directory
 *   - projects:  the registry files ~/.hive/projects/<name>/config.md
 *   - memory and tickets: the `hive` MCP server every Claude session loads
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

import { runProcess, type Run } from "./claude";

export function resolveHiveHome(): string {
  return process.env.HIVE_HOME || join(homedir(), ".hive");
}

export function findHiveBin(): string {
  return process.env.COMB_HIVE_BIN || "hive";
}

/** HIVE identity for a session in `cwd`: soul, Greg, project memory, taste. */
export async function hiveIdentity(cwd: string, run: Run = runProcess): Promise<string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  let res;
  try {
    res = await run([findHiveBin(), "identity", "emit"], { cwd, env });
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

  async close(): Promise<void> {
    try { await this.client?.close(); } catch { /* intentional: already closed */ }
    this.client = null;
  }
}

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
