/**
 * comb-mcp: comb's MCP tools. comb hands it to each agent it starts with
 * --mcp-config (COMB_AGENT names that agent); Greg's sessions load it from
 * user scope. Four tools: the roster, a message to anyone, a new agent, and
 * an item in front of Greg.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { formatAgentList, GREG, listAgents, sendToAgent, startAgent } from "./agents";
import { findClaudeBin, listLiveSessions } from "./claude";
import { addItem } from "./queue";

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

const server = new McpServer(
  { name: "comb", version: "0.2.0" },
  {
    instructions:
      "comb runs agents: background sessions, one job each, with a workspace under ~/.comb/agents/<name>/. " +
      "agent_list is the roster. agent_send messages any agent or session and works whether it is working or asleep. " +
      "agent_start makes a new agent. queue_add puts a proposal, decision, review or blocker in front of Greg.",
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
    const { woke } = await sendToAgent({ name: to, message, from });
    const how = woke ? "It was asleep and is waking with your message." : "Delivered.";
    const reply = from ? ` Its reply will come to "${from}".` : "";
    return { content: [{ type: "text" as const, text: `${how}${reply}` }] };
  } catch (err) {
    return fail(err);
  }
});

server.registerTool("queue_add", {
  description:
    "Put something in front of Greg: a proposal worth doing, a decision that is his, work ready for his review, " +
    "or a blocker only he can clear. It appears on his page with Go / Not now / Redirect, and his answer comes back " +
    "to you as a message. File one item per ask, with your recommendation, instead of asking in prose. Do not " +
    "file what you can decide yourself.",
  inputSchema: {
    kind: z.enum(["proposal", "decision", "review", "blocker"]),
    title: z.string().describe("What Greg says yes or no to, in under 80 characters. E.g. 'Start a revrec agent on TK-143'."),
    action: z.string().describe("Exactly what you will do when he says go, in one sentence."),
    why: z.string().describe("Your case in Markdown: why now, your recommendation, the evidence, what it costs."),
    project: z.string().optional().describe("The hive project, if there is one."),
    ticket: z.string().optional().describe("The ticket ID, if there is one."),
  },
}, async ({ kind, title, action, why, project, ticket }) => {
  try {
    const from = (await caller()) ?? "unknown";
    const item = await addItem({ kind, from, title, action, body: why, project, ticket });
    return { content: [{ type: "text" as const, text: `Filed ${item.id}. Greg's answer will come to "${from}" as a message.` }] };
  } catch (err) {
    return fail(err);
  }
});

server.registerTool("agent_start", {
  description:
    "Make a new comb agent: a background Claude Code session with one job, its own workspace and a charter, " +
    "with you as its parent. Use it for a job that should run on its own and report back, not for a quick " +
    "lookup (use your harness's sub-agents for that). Name it <project>-<job>, e.g. 'revrec-tk109-backtest'. " +
    "The charter carries the context: the ticket, what done means, and where the design docs and memory are. " +
    "Set worktree when it will edit code. For a follow-up on a job that already has an agent, use agent_send.",
  inputSchema: {
    name: z.string().describe("Lowercase name, e.g. 'rate-limiter'."),
    charter: z.string().describe("What the agent is for, in prose: its scope and what done looks like."),
    prompt: z.string().optional().describe("First message. Defaults to reading its charter and beginning."),
    cwd: z.string().optional().describe("Directory to run in. Defaults to your own working directory."),
    worktree: z.boolean().optional().describe("Create a git worktree and branch for this agent."),
    model: z.string().optional().describe("Model alias: 'opus' for judgment-heavy roles, 'sonnet' for routine work. Omit for the default."),
  },
}, async ({ name, charter, prompt, cwd, worktree, model }) => {
  try {
    const parent = process.env.COMB_AGENT || GREG;
    const { session, dir } = await startAgent({ name, charter, prompt, cwd, worktree, parent, model });
    return {
      content: [{
        type: "text" as const,
        text: `Started ${session.name} in ${session.cwd}. Workspace: ${dir}. Message it with agent_send to "${session.name}".`,
      }],
    };
  } catch (err) {
    return fail(err);
  }
});

await server.connect(new StdioServerTransport());
