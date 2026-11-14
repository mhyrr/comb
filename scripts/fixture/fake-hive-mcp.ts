#!/usr/bin/env bun
/**
 * A stand-in for hive's MCP server, for the screenshot fixture only. It
 * answers the three read-only tools comb's page calls (list_tickets,
 * show_ticket, read_hive_memory) from $HOME/hive-fixture.json, in the text
 * formats src/hive.ts parses.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

type Ticket = { id: string; status: string; priority: number; type: string; title: string; tags?: string[]; body?: string };
type Fixture = { tickets: Record<string, Ticket[]>; memory: Record<string, string> };

const fixture = JSON.parse(readFileSync(join(process.env.HOME ?? "", "hive-fixture.json"), "utf-8")) as Fixture;
const LEVEL = ["critical", "high", "medium", "low", "backlog"];
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const server = new McpServer({ name: "hive", version: "0.0.0-fixture" });

server.registerTool("list_tickets", {
  inputSchema: { project: z.string(), status: z.string().optional() },
}, async ({ project, status }) => {
  const rows = (fixture.tickets[project] ?? []).filter((t) => !status || t.status === status);
  return text(rows.map((t) =>
    `${t.id}  ${t.status}  P${t.priority}-${LEVEL[t.priority] ?? "low"}  ${t.type}  ${t.title}${t.tags?.length ? ` [${t.tags.join(", ")}]` : ""}`,
  ).join("\n"));
});

server.registerTool("show_ticket", {
  inputSchema: { project: z.string(), id: z.string() },
}, async ({ project, id }) => {
  const t = (fixture.tickets[project] ?? []).find((x) => x.id === id);
  if (!t) return { ...text(`No ticket ${project}/${id}`), isError: true };
  return text(`# ${t.id}: ${t.title}\n\n**Status:** ${t.status}\n**Priority:** P${t.priority}\n**Type:** ${t.type}\n\n---\n\n${t.body ?? ""}`);
});

server.registerTool("read_hive_memory", {
  inputSchema: { project: z.string(), include_superseded: z.boolean().optional() },
}, async ({ project }) => text(fixture.memory[project] ?? ""));

await server.connect(new StdioServerTransport());
