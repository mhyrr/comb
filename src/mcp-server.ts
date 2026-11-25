/**
 * comb-mcp: comb's MCP tools. comb hands it to each agent it starts with
 * --mcp-config (COMB_AGENT names that agent); the user's own sessions load it from
 * user scope. Five tools: the roster, a message to anyone, a new agent, an
 * item in front of the user, and taking a stale item back.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { formatAgentList, GREG, listAgents, sendToAgent, startAgent } from "./agents";
import { human, readCombConfig } from "./config";
import { findClaudeBin, listLiveSessions } from "./claude";
import { MODELS } from "./models";
import { addItem, withdrawItem } from "./queue";

/**
 * Who is calling: the agent this server was started for, or else the Claude
 * session that spawned it (its row in `claude agents` carries our parent pid).
 */
async function caller(): Promise<string | null> {
  if (process.env.COMB_AGENT) return process.env.COMB_AGENT;
  try {
    const rows = await listLiveSessions(findClaudeBin());
    return rows.find((r) => r.pid === process.ppid)?.name ?? null;
  } catch {
    return null; // intentional: no reply address is better than no message
  }
}

// How the tools name the human: config.json's userName, else "the user".
const config = readCombConfig();
const who = human(config);
const defaultModel = config.defaultModel;

const server = new McpServer(
  { name: "comb", version: "0.2.0" },
  {
    instructions:
      "comb runs agents: background sessions, one job each, with a workspace under ~/.comb/agents/<name>/. " +
      "agent_list is the roster. agent_send messages any agent or session and works whether it is working or asleep. " +
      `agent_start makes a new agent. queue_add puts a proposal, decision, review or blocker in front of ${who.name}; ` +
      "queue_withdraw takes one back when its work is done or taken elsewhere.",
  },
);

const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
});

server.registerTool("agent_list", {
  description:
    "The roster of comb agents: each one's name, whether it is working right now or ready, what it is for, " +
    "and the last line of its log. Every agent on it can take a message with agent_send.",
  inputSchema: {},
}, async () => {
  try {
    return { content: [{ type: "text" as const, text: formatAgentList(await listAgents()) }] };
  } catch (err) {
    return fail(err);
  }
});

server.registerTool("agent_send", {
  description:
    "Send a message to a comb agent, or to any open Claude session, by name. It arrives whether the agent " +
    "is working, idle or asleep: an asleep agent wakes with its history and the message. The reply comes " +
    "back to you as a message. Use this instead of SendMessage for comb agents.",
  inputSchema: {
    to: z.string().describe("Agent or session name, e.g. 'maya'."),
    message: z.string().describe("The message, with the context the recipient cannot see from where it is."),
  },
}, async ({ to, message }) => {
  try {
    const from = await caller();
    const { woke, forwardedTo, reason } = await sendToAgent({ name: to, message, from });
    if (forwardedTo) {
      const text = `Not delivered: comb could not wake ${to} (${reason}). The message is in its log.md, and ${forwardedTo} has it now.`;
      return { content: [{ type: "text" as const, text }] };
    }
    const how = woke ? "It was asleep and is waking with your message." : "Delivered.";
    const reply = from ? ` Its reply will come to "${from}".` : "";
    return { content: [{ type: "text" as const, text: `${how}${reply}` }] };
  } catch (err) {
    return fail(err);
  }
});

server.registerTool("queue_add", {
  description:
    `Put something in front of ${who.name}: a proposal worth doing, a decision that is theirs, work ready for review, ` +
    `or a blocker only they can clear. It appears on the comb page with Go / Not now / Redirect, and the answer comes back ` +
    "to you as a message. File one item per ask, with your recommendation, instead of asking in prose. Do not " +
    "file what you can decide yourself.",
  inputSchema: {
    kind: z.enum(["proposal", "decision", "review", "blocker"]),
    title: z.string().describe(`What ${who.name} says yes or no to, in under 80 characters. E.g. 'Start an acme-api agent on TK-143'.`),
    action: z.string().describe("Exactly what you will do on go, in one sentence."),
    changes: z.string().optional().describe(
      `Required for a proposal: what changes for ${who.name} if they say go, from their side of the screen, in one or two ` +
      `sentences. What they will see, do or stop doing differently; or "Nothing visible:" plus what changes underneath. ` +
      `Not the implementation. Good: "The queue shows a 'What changes for you' line on every proposal." ` +
      `Bad: "Adds a changes field to QueueItem." The card shows it first, above your case.`,
    ),
    why: z.string().describe("Your case in Markdown: why now, your recommendation, the evidence, what it costs."),
    project: z.string().optional().describe("The project, if there is one."),
    ticket: z.string().optional().describe("The ticket ID, if there is one."),
    model: z.enum(MODELS).optional().describe(
      `For an item whose go starts an agent (a proposal, or a review that starts one): the model you recommend. ` +
      `${who.Name} sees it on the Go button and can change it; the answer names the model to start with. ` +
      `Omit it to offer the default (${defaultModel}). Never set it on a decision or blocker.`,
    ),
    model_why: z.string().optional().describe("With model: why that model, in one line. E.g. 'Mechanical rename across 40 files; sonnet is enough.'"),
    on_no: z.string().optional().describe(
      `What happens if ${who.name} says Not now, in one sentence, when it changes something: 'The branch stays open; I stop here.' ` +
      "Omit it when nothing happens beyond you hearing the reason; the page says that by default.",
    ),
    on_redirect: z.string().optional().describe(
      "The redirect you expect, if there is an obvious one: 'Say Redis and I ship Redis instead.' Omit it otherwise.",
    ),
  },
}, async ({ kind, title, action, changes, why, project, ticket, model, model_why, on_no, on_redirect }) => {
  try {
    const from = (await caller()) ?? "unknown";
    const item = await addItem({ kind, from, title, action, changes, body: why, project, ticket, model, modelWhy: model_why, onNo: on_no, onRedirect: on_redirect });
    return { content: [{ type: "text" as const, text: `Filed ${item.id}. The answer will come to "${from}" as a message.` }] };
  } catch (err) {
    return fail(err);
  }
});

server.registerTool("queue_withdraw", {
  description:
    `Take an open queue item away without an answer from ${who.name}: its work is done, or it was taken elsewhere ` +
    `(a ticket closed, a branch already holds it, ${who.name} did it in their own session). It is not a Not now: ` +
    `nothing reaches hive as a precedent and no answer goes to the filer. The page shows it under "Withdrawn" with ` +
    `your reason. Use it only for items you know are stale; never to decide for ${who.name}.`,
  inputSchema: {
    id: z.string().describe("The queue item id, e.g. '2026-11-20-start-contentdash-tk-002-step-2-carousel'."),
    reason: z.string().describe("Why, in one line, e.g. 'TK-002 was built on branch step-2-carousels in Greg's session'."),
  },
}, async ({ id, reason }) => {
  try {
    const from = (await caller()) ?? "unknown";
    const item = await withdrawItem(id, reason, from);
    return { content: [{ type: "text" as const, text: `Withdrew ${item.id}: ${item.withdrawnWhy}` }] };
  } catch (err) {
    return fail(err);
  }
});

server.registerTool("agent_start", {
  description:
    "Make a new comb agent: a background Claude Code session with one job, its own workspace and a charter, " +
    "with you as its parent. Use it for a job that should run on its own and report back, not for a quick " +
    "lookup (use your harness's sub-agents for that). Name it <project>-<job>, e.g. 'acme-api-tk109-backtest'. " +
    "The charter carries the context: the ticket, what done means, and where the design docs and memory are. " +
    "Set worktree when it will edit code. For a follow-up on a job that already has an agent, use agent_send. " +
    "To restart an existing agent in a new conversation, pass its name and fresh, with no charter.",
  inputSchema: {
    name: z.string().describe("Lowercase name, e.g. 'rate-limiter'."),
    charter: z.string().optional().describe(
      "What the agent is for, in prose: its scope and what done looks like. Required for a new agent; omit it for an existing one.",
    ),
    prompt: z.string().optional().describe("First message. Defaults to reading its charter and beginning."),
    cwd: z.string().optional().describe("Directory to run in. Defaults to your own working directory."),
    worktree: z.boolean().optional().describe("Create a git worktree and branch for this agent."),
    model: z.string().optional().describe(
      `Model alias (${MODELS.join(", ")}). When ${who.name}'s go names a model ("Go (model: fable)"), pass exactly that. ` +
      `Otherwise 'opus' for judgment-heavy roles, 'sonnet' for routine work. Omit it for the default (${defaultModel}). ` +
      "The agent keeps its model when it wakes.",
    ),
    fresh: z.boolean().optional().describe(
      "For an existing agent: start a new conversation from its workspace (charter, checklist, memory/, log.md) " +
      "instead of resuming the old one, and stop the old session if it is live. Use after a comb upgrade, so the " +
      "agent loads new tool schemas. Default: resume.",
    ),
  },
}, async ({ name, charter, prompt, cwd, worktree, model, fresh }) => {
  try {
    const parent = process.env.COMB_AGENT || GREG;
    // Stopping the caller's own session would end this call before the new one starts.
    if (fresh && name === process.env.COMB_AGENT) {
      throw new Error(`An agent cannot restart itself fresh. Ask ${who.name} to run: comb start ${name} --fresh`);
    }
    const { session, dir, restarted } = await startAgent({ name, charter, prompt, cwd, worktree, parent, model, fresh });
    const verb = restarted ? (fresh ? "Restarted fresh" : "Restarted") : "Started";
    return {
      content: [{
        type: "text" as const,
        text: `${verb} ${session.name} in ${session.cwd}. Workspace: ${dir}. Message it with agent_send to "${session.name}".`,
      }],
    };
  } catch (err) {
    return fail(err);
  }
});

await server.connect(new StdioServerTransport());
