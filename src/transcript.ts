/**
 * Claude Code session transcripts, read as what the page shows: messages
 * arriving, the agent's own words, tool calls and their results, and the end
 * of each turn. Format verified against Claude Code 2.1.322 JSONL.
 *
 * Transcripts are Claude Code's files. comb only reads them.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export type FeedEvent =
  /** A message that started a turn. `from` is a session or agent name, or "greg". */
  | { k: "in"; id: string; at: string; from: string; text: string }
  /** The agent's own text. */
  | { k: "say"; id: string; at: string; text: string }
  /** A tool call. `status` changes when its result arrives (see "done"). */
  | { k: "tool"; id: string; at: string; name: string; detail: string; status: "run" | "ok" | "err" }
  /** The result of an earlier tool call, by its id. */
  | { k: "done"; id: string; ref: string; ok: boolean }
  /** The turn ended; the agent is waiting. */
  | { k: "idle"; id: string; at: string; ms: number | null };

/**
 * The page signs the human's messages "<Name>, on the comb page:". Older
 * transcripts say "Greg, on the comb page:"; any name parses as the human.
 */
export function pageSignature(Name: string): string {
  return `${Name}, on the comb page:`;
}
/**
 * The page always puts a line break after the signature, which keeps prose
 * that mentions the page from matching. The original "Greg, on the comb
 * page:" matches as it always did, with or without one.
 */
const PAGE_SIGNED = /^(?:Greg, on the comb page:|[^\n,:]{1,80}, on the comb page:(?=\n|$))/;

export function transcriptPath(cwd: string, sessionId: string, claudeHome = join(homedir(), ".claude")): string {
  return join(claudeHome, "projects", cwd.replace(/[/.]/g, "-"), `${sessionId}.jsonl`);
}

type Line = Record<string, any>;

/**
 * Parses transcript lines into feed events. `defaultFrom` names whoever sent
 * a plain prompt: "greg" for an interactive session, the parent for an agent.
 */
export function parseLines(lines: string[], defaultFrom: string, cwd = ""): FeedEvent[] {
  const out: FeedEvent[] = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let d: Line;
    try {
      d = JSON.parse(raw);
    } catch {
      continue; // intentional: a partly written last line arrives whole on the next read
    }
    if (d.isSidechain) continue;
    const at: string = d.timestamp ?? "";
    const uuid: string = d.uuid ?? `${at}-${out.length}`;

    if (d.type === "system" && d.subtype === "turn_duration") {
      out.push({ k: "idle", id: uuid, at, ms: typeof d.durationMs === "number" ? d.durationMs : null });
      continue;
    }

    // A message that reaches a session mid-turn is recorded only as a queued
    // command, stamped when it arrived (TK-013).
    const queued = d.type === "attachment" && d.attachment?.type === "queued_command" ? d.attachment.prompt : null;
    if (typeof queued === "string" && queued.includes("<cross-session-message")) {
      const msg = incoming(queued, defaultFrom);
      if (msg) out.push({ k: "in", id: uuid, at, ...msg });
      continue;
    }

    // A message that reaches an idle live session is recorded as a meta line;
    // other meta lines are harness bookkeeping.
    const content = d.message?.content;
    const peer = typeof content === "string" && content.includes("<cross-session-message");
    if (d.type === "user" && (!d.isMeta || peer)) {
      if (typeof content === "string") {
        const msg = incoming(content, defaultFrom);
        if (msg) out.push({ k: "in", id: uuid, at, ...msg });
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === "tool_result" && b.tool_use_id) {
            out.push({ k: "done", id: `${uuid}-${b.tool_use_id}`, ref: b.tool_use_id, ok: !b.is_error });
          } else if (b?.type === "text" && typeof b.text === "string") {
            const msg = incoming(b.text, defaultFrom);
            if (msg) out.push({ k: "in", id: `${uuid}-t`, at, ...msg });
          }
        }
      }
      continue;
    }

    if (d.type === "assistant" && Array.isArray(d.message?.content)) {
      for (const b of d.message.content) {
        if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
          out.push({ k: "say", id: `${uuid}-${out.length}`, at, text: b.text.trim() });
        } else if (b?.type === "tool_use" && b.id) {
          out.push({ k: "tool", id: b.id, at, name: toolName(b.name), detail: toolDetail(b.name, b.input ?? {}, cwd), status: "run" });
        }
      }
    }
  }
  return out;
}

/** Folds "done" events into their tool calls. Returns the events that still stand alone. */
export function settle(events: FeedEvent[]): FeedEvent[] {
  const tools = new Map<string, Extract<FeedEvent, { k: "tool" }>>();
  const out: FeedEvent[] = [];
  for (const e of events) {
    if (e.k === "tool") {
      tools.set(e.id, e);
      out.push(e);
    } else if (e.k === "done") {
      const t = tools.get(e.ref);
      if (t) t.status = e.ok ? "ok" : "err";
      else out.push(e);
    } else {
      out.push(e);
    }
  }
  return out;
}

/** Who sent a prompt, and its text without the envelope. Null for harness noise. */
export function incoming(content: string, defaultFrom: string): { from: string; text: string } | null {
  let text = content.trim();
  let from = defaultFrom;
  if (!text) return null;
  // Slash commands, command output, interruptions and reminders are the harness talking.
  if (/^<(command-|local-command|system-reminder|bash-|task-notification)/.test(text)) return null;
  if (text.startsWith("[Request interrupted")) return null;

  const cross = text.match(/<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>/);
  if (cross) {
    from = cross[1]!.match(/from-name="([^"]*)"/)?.[1] || "a session";
    text = cross[2]!.trim();
  }
  const comb = text.match(/^Message from ([^.\n]+)\.(?: Reply with the comb agent_send tool to "[^"]*"\.\s+|\s*\n\n)/);
  if (comb) {
    from = comb[1]!.trim();
    text = text.slice(comb[0].length).trim();
  }
  // comb's own start and restart prompts (src/agents.ts), and Claude Code's
  // summary after it compacts a conversation: no one's words.
  if (/^(You were restarted from your workspace\.|Read your charter\.md and checklist\.md, then begin\.|This session is being continued from a previous conversation)/.test(text)) {
    return { from: "comb", text };
  }
  const signed = text.match(PAGE_SIGNED);
  if (signed) {
    from = "greg";
    text = text.slice(signed[0].length).replace(/^\s*\(.*?\)\s*/, "").trim();
  }
  return { from, text };
}

function toolName(name: string): string {
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  return mcp ? `${mcp[2]}` : name;
}

/** One line saying what a tool call does, in the terms its input gives. */
export function toolDetail(name: string, input: Record<string, any>, cwd = ""): string {
  const rel = (p: unknown) => {
    const s = String(p ?? "");
    if (cwd && s.startsWith(cwd + "/")) return s.slice(cwd.length + 1);
    const home = homedir();
    return s.startsWith(home + "/") ? "~" + s.slice(home.length) : s;
  };
  let s: string;
  switch (name) {
    case "Bash": s = input.description || input.command || ""; break;
    case "Read": case "Write": case "Edit": case "NotebookEdit": s = rel(input.file_path ?? input.notebook_path); break;
    case "Grep": case "Glob": s = input.pattern ?? ""; break;
    case "WebSearch": s = input.query ?? ""; break;
    case "WebFetch": s = input.url ?? ""; break;
    case "Agent": case "Task": s = input.description ?? ""; break;
    case "Skill": s = input.skill ?? ""; break;
    case "ToolSearch": s = input.query ?? ""; break;
    case "SendMessage": s = `to ${input.to ?? input.recipient ?? "?"}`; break;
    default: {
      if (name.endsWith("agent_send")) { s = `to ${input.to ?? "?"}`; break; }
      const first = Object.values(input).find((v) => typeof v === "string" && v.trim());
      s = typeof first === "string" ? first : "";
    }
  }
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > 140 ? s.slice(0, 139) + "…" : s;
}
