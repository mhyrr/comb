/**
 * comb-mcp: comb's MCP tools. comb hands it to each agent it starts with
 * --mcp-config (COMB_AGENT names that agent); Greg's sessions load it from
 * user scope. Three tools: the roster, a message to anyone, a new agent.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { formatAgentList, GREG, listAgents, sendToAgent, startAgent } from "./agents";
import { findClaudeBin, listLiveSessions } from "./claude";

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
      "comb runs agents: long-lived background sessions, each with a workspace under ~/.comb/agents/<name>/. " +
      "agent_list is the roster. agent_send messages any agent or session and works whether it is working or asleep. " +
      "agent_start makes a new agent.",
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

server.registerTool("agent_start", {
  description:
    "Make a new comb agent: a long-lived background Claude Code session with its own workspace and a charter, " +
    "with you as its parent. Use it for work that should run on its own, not for a quick lookup (use your " +
    "harness's sub-agents for that). Set worktree when it will edit code. To talk to an agent that already " +
    "exists, use agent_send.",
  inputSchema: {
    name: z.string().describe("Lowercase name, e.g. 'rate-limiter'."),
    charter: z.string().describe("What the agent is for, in prose: its scope and what done looks like."),
    prompt: z.string().optional().describe("First message. Defaults to reading its charter and beginning."),
    cwd: z.string().optional().describe("Directory to run in. Defaults to your own working directory."),
    worktree: z.boolean().optional().describe("Create a git worktree and branch for this agent."),
  },
}, async ({ name, charter, prompt, cwd, worktree }) => {
  try {
    const parent = process.env.COMB_AGENT || GREG;
    const { session, dir } = await startAgent({ name, charter, prompt, cwd, worktree, parent });
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
