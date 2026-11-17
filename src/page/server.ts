/**
 * comb's page: one local, live screen onto the agents (design §9.1).
 *
 *   GET  /                      the page
 *   GET  /api/events            SSE: "state" snapshots (tree, sessions) as they change
 *   GET  /api/feed?agent=|session=   SSE: "reset" with recent history, then "events"
 *   POST /api/send              { to, message } signed as Greg on the page
 *   GET  /api/agent/:name/:file charter | checklist | log
 *   GET  /api/agent/:name/reports
 *   GET  /api/tickets, /api/ticket?project&id
 *   GET  /api/memory?project    parsed entries; the page filters them itself
 *   POST /api/queue/:id/answer  { answer: go | no | redirect, note, model? } back to the asking agent
 *   POST /api/tickets/start     { project, id } handed to Maya to route
 *   POST /api/upload            an image body; saved to ~/.comb/inbox/, path returned
 *   POST /api/agent/:name/terminal  a terminal tab in the agent's directory running `hive attach <name>`
 *   GET  /api/inbox/:file       a saved image
 *   GET  /api/usage             plan limits (src/limits.ts) and token counts per AI harness on this machine (src/usage.ts)
 *   GET  /api/pulls             open GitHub PRs in hive's projects (gh, read-only, cached)
 *
 * Loopback only, and every request must name this server as its Host (and
 * Origin, for a POST), so no other site can drive the agents.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { human, readCombConfig, type Human } from "../config";
import { agentDir, GREG, readAgentSession, sendToAgent, validateAgentName } from "../agents";
import { findClaudeBin, listLiveSessions, runProcess, type LiveSession, type Run } from "../claude";
import { findGhBin, PullWatch } from "../github";
import { detectHive, HiveClient, hiveProjectPaths, listHiveProjects, type HiveSetup, type Ticket } from "../hive";
import { resolveCombHome } from "../paths";
import { formatNightly, runNightly } from "../nightly";
import { isModel, MODELS } from "../models";
import { answerMessage, answerModel, readItem, recordAnswer } from "../queue";
import { transcriptPath } from "../transcript";
import { readLimits } from "../limits";
import { UsageIndex, type Roots } from "../usage";
import { agentWorkdir, findHiveBin, findRexBin, openInTerminal } from "../terminal";
import { Tail } from "./feed";
import { buildSnapshot, type Snapshot } from "./state";
import page from "./ui/index.html";

export type PageOpts = {
  port?: number;
  home?: string;
  claudeBin?: string;
  run?: Run;
  /** How often to poll `claude agents --json` while a page is open. */
  pollMs?: number;
  hive?: HiveClient;
  /** Whether hive is on (D24). Detected once, at start, when omitted. */
  hiveSetup?: HiveSetup;
  /** The rex CLI; null means Rex is not installed. Found when omitted. */
  rexBin?: string | null;
  /** The hive CLI; null means hive is not installed. Found when omitted. */
  hiveBin?: string | null;
  /** File hive's nightly picks (and asks, if on) into the queue on start and at this interval. Off when unset, and without hive. */
  nightlyMs?: number;
  /** Where the usage panel reads each harness's files. The real home's when omitted. */
  usageRoots?: Roots;
  /** The plan-limits file (src/limits.ts). Vibe Island's rl.json under the real home when omitted. */
  limitsPath?: string;
  /** The gh CLI; null means gh is not installed. Found when omitted. */
  ghBin?: string | null;
  /** How old the open-PR cache may get before a read refreshes it. */
  pullsTtlMs?: number;
  /** Refresh open PRs on start and at this interval while a page is open. Off when unset. */
  pullsMs?: number;
};

const FEED_MS = 600;
const MAX_UPLOAD = 15 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
/** Names the upload route makes, and nothing else: no paths, no dot files. */
const INBOX_NAME = /^[0-9TZ-]+-[0-9a-f]{8}\.(png|jpg|gif|webp)$/;
const TICKET_TTL_MS = 30_000;
const USAGE_TTL_MS = 60_000;

export function startPage(opts: PageOpts = {}) {
  const port = opts.port ?? Number(process.env.COMB_PAGE_PORT || 4747);
  const home = opts.home ?? resolveCombHome();
  const claude = opts.claudeBin ?? findClaudeBin();
  const run = opts.run ?? runProcess;
  const pollMs = opts.pollMs ?? 2500;
  // Snapshots read config.json quietly every poll; say once, at start, if it is broken.
  const config = readCombConfig(home, (msg) => console.error(`comb page: ${msg}`));
  // hive is decided once, here: tickets, memory, nightly and `hive attach` follow it.
  const setup = opts.hiveSetup ?? detectHive({ mode: config.hive });
  const hiveOn = setup.enabled;
  if (!opts.hiveSetup) console.log(`comb page: hive ${hiveOn ? "on" : "off"} (${setup.why})`);
  const hive = opts.hive ?? new HiveClient();
  const rexBin = opts.rexBin !== undefined ? opts.rexBin : findRexBin();
  const hiveBin = !hiveOn ? null : opts.hiveBin !== undefined ? opts.hiveBin : findHiveBin();
  const enc = new TextEncoder();
  const noHive = () => json({ error: "Tickets and memory come from hive, which is not installed.", hive: false }, 404);

  // --- open GitHub PRs in hive's projects (the page server runs gh) ---------
  const pulls = new PullWatch({
    projects: () => hiveOn ? hiveProjectPaths(setup.home) : [],
    gh: opts.ghBin !== undefined ? opts.ghBin : findGhBin(),
    run,
    ttlMs: opts.pullsTtlMs ?? 4 * 60_000,
  });
  let pullsTimer: ReturnType<typeof setInterval> | null = null;
  if (opts.pullsMs && hiveOn) {
    void pulls.refresh();
    pullsTimer = setInterval(() => { if (stateClients.size > 0 && pulls.stale()) void pulls.refresh(); }, opts.pullsMs);
  }

  // --- live state ----------------------------------------------------------
  let live: LiveSession[] = [];
  let snapshot: Snapshot | null = null;
  let snapshotJson = "";
  const stateClients = new Set<(event: string, data: unknown) => void>();

  async function refresh(): Promise<void> {
    let liveError: string | null = null;
    try {
      live = await listLiveSessions(claude, run);
    } catch (err) {
      liveError = err instanceof Error ? err.message : String(err);
    }
    const next = await buildSnapshot({ home, live, liveError, hive: hiveOn, hiveHome: setup.home });
    const json = JSON.stringify({ ...next, at: undefined });
    if (json === snapshotJson) return;
    snapshot = next;
    snapshotJson = json;
    for (const send of stateClients) send("state", next);
  }

  let polling = false;
  const timer = setInterval(async () => {
    if (stateClients.size === 0 || polling) return;
    polling = true;
    try { await refresh(); } catch (err) { console.error("comb page: refresh failed:", err); } finally { polling = false; }
  }, pollMs);

  // --- hive's nightly, into the queue (§9.3) ---------------------------------
  let nightlyTimer: ReturnType<typeof setInterval> | null = null;
  if (opts.nightlyMs && hiveOn) {
    let filing = false;
    const fileNightly = async () => {
      if (filing) return;
      filing = true;
      try {
        const r = await runNightly({ home, hiveHome: setup.home });
        if (r.filed.length || r.deferred.length) console.log(`${new Date().toISOString()} ${formatNightly(r)}`);
      } catch (err) {
        console.error("comb page: hive nightly filing failed:", err);
      } finally {
        filing = false;
      }
    };
    void fileNightly();
    nightlyTimer = setInterval(fileNightly, opts.nightlyMs);
  }

  function eventStream(onStart: (send: (event: string, data: unknown) => void) => () => void): Response {
    let stop = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: unknown) => {
          try { controller.enqueue(enc.encode(sse(event, data))); } catch { stop(); }
        };
        const keepalive = setInterval(() => {
          try { controller.enqueue(enc.encode(": keepalive\n\n")); } catch { stop(); }
        }, 15_000);
        const cleanup = onStart(send);
        stop = () => { clearInterval(keepalive); cleanup(); };
      },
      cancel() { stop(); },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  // --- feeds -----------------------------------------------------------------
  type Target = { path: string; defaultFrom: string; cwd: string; sessionId: string };

  async function resolveTarget(url: URL): Promise<Target | null> {
    const agent = url.searchParams.get("agent");
    if (agent) {
      const s = await readAgentSession(validateAgentName(agent), home);
      return s ? { path: transcriptPath(s.cwd, s.sessionId), defaultFrom: s.parent, cwd: s.cwd, sessionId: s.sessionId } : null;
    }
    const id = url.searchParams.get("session");
    const row = id ? live.find((r) => r.sessionId === id) : undefined;
    if (!row) return null;
    return {
      path: transcriptPath(row.cwd, row.sessionId),
      defaultFrom: row.kind === "interactive" ? GREG : "comb",
      cwd: row.cwd,
      sessionId: row.sessionId,
    };
  }

  function feed(url: URL): Response {
    return eventStream((send) => {
      let tail: Tail | null = null;
      let sessionId = "";
      let busy = false;
      let ticks = 0;
      const tick = async () => {
        if (busy) return;
        busy = true;
        try {
          // Re-resolve now and then: a woken agent moves to a new session.
          if (!tail || ticks++ % 5 === 0) {
            const t = await resolveTarget(url);
            if (t && t.sessionId !== sessionId) {
              sessionId = t.sessionId;
              tail = new Tail(t.path, t.defaultFrom, t.cwd);
              send("reset", { sessionId, events: await tail.history() });
              return;
            }
            if (!t && !tail) {
              send("reset", { sessionId: null, events: [] });
              return;
            }
          }
          const events = tail ? await tail.next() : [];
          if (events.length) send("events", events);
        } catch (err) {
          send("problem", { message: err instanceof Error ? err.message : String(err) });
        } finally {
          busy = false;
        }
      };
      void tick();
      const t = setInterval(tick, FEED_MS);
      return () => clearInterval(t);
    });
  }

  // --- tickets ---------------------------------------------------------------
  let ticketCache: { at: number; tickets: Ticket[]; failed: string[] } | null = null;
  async function allTickets(force: boolean) {
    if (!force && ticketCache && Date.now() - ticketCache.at < TICKET_TTL_MS) return ticketCache;
    const projects = listHiveProjects(setup.home);
    const failed: string[] = [];
    const lists = await Promise.all(projects.map(async (p) => {
      try {
        return [...await hive.tickets(p, "in_progress"), ...await hive.tickets(p, "open")];
      } catch {
        failed.push(p);
        return [];
      }
    }));
    ticketCache = { at: Date.now(), tickets: lists.flat(), failed };
    return ticketCache;
  }

  // --- usage (the Now tab's usage panel) --------------------------------------
  // Read off the request path: a request gets the last summary at once and
  // starts a fresh read if that one is over a minute old. The first read waits
  // for the first request, so a page nobody opens never walks the transcripts.
  const usage = new UsageIndex({ roots: opts.usageRoots, cachePath: join(home, "cache", "usage.json") });
  let usageRun: Promise<void> | null = null;
  let usageAt = 0;
  let usageError: string | null = null;
  function refreshUsage(): Promise<void> {
    usageRun ??= usage.refresh()
      .then(() => { usageError = null; })
      .catch((err) => { usageError = err instanceof Error ? err.message : String(err); console.error("comb page: usage read failed:", err); })
      .finally(() => { usageAt = Date.now(); usageRun = null; });
    return usageRun;
  }

  // --- requests ---------------------------------------------------------------
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  function guard(req: Request): Response | null {
    const host = req.headers.get("host") ?? "";
    if (!allowedHosts.has(host)) return json({ error: "Wrong host." }, 403);
    if (req.method !== "GET") {
      const origin = req.headers.get("origin");
      if (!origin || !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) return json({ error: "Wrong origin." }, 403);
    }
    return null;
  }

  const api = async (req: Request, fn: (url: URL) => Promise<Response> | Response): Promise<Response> => {
    const denied = guard(req);
    if (denied) return denied;
    try {
      return await fn(new URL(req.url));
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0, // SSE connections stay open
    development: process.env.COMB_PAGE_DEV === "1",
    routes: {
      "/": page,
      "/api/events": (req) => api(req, () => eventStream((send) => {
        stateClients.add(send);
        if (snapshot) send("state", snapshot);
        else void refresh().catch((err) => send("problem", { message: String(err) }));
        return () => { stateClients.delete(send); };
      })),
      "/api/feed": (req) => api(req, (url) => feed(url)),
      "/api/send": {
        POST: (req) => api(req, async () => {
          const body = (await req.json().catch(() => null)) as { to?: unknown; message?: unknown } | null;
          const to = typeof body?.to === "string" ? body.to.trim() : "";
          const message = typeof body?.message === "string" ? body.message.trim() : "";
          if (!to || !message) return json({ error: "Name an agent and write a message." }, 400);
          const { woke } = await sendToAgent({ name: to, message, fromPage: true, home, claudeBin: claude, run });
          void refresh().catch(() => {});
          return json({ woke });
        }),
      },
      "/api/upload": {
        POST: (req) => api(req, async () => {
          const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim();
          const ext = IMAGE_TYPES[type];
          if (!ext) return json({ error: "Only PNG, JPEG, GIF or WebP images can be attached." }, 415);
          const bytes = new Uint8Array(await req.arrayBuffer());
          if (bytes.length === 0) return json({ error: "The image was empty." }, 400);
          if (bytes.length > MAX_UPLOAD) return json({ error: "That image is over 15 MB." }, 413);
          const dir = join(home, "inbox");
          await mkdir(dir, { recursive: true });
          const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
          await writeFile(join(dir, name), bytes);
          return json({ path: join(dir, name), url: `/api/inbox/${name}` });
        }),
      },
      "/api/inbox/:file": (req) => api(req, async () => {
        const file = req.params.file;
        if (!INBOX_NAME.test(file)) return json({ error: "No such file." }, 404);
        const f = Bun.file(join(home, "inbox", file));
        return (await f.exists()) ? new Response(f, { headers: { "cache-control": "private, max-age=86400" } }) : json({ error: "No such file." }, 404);
      }),
      "/api/queue/:id/answer": {
        POST: (req) => api(req, async () => {
          const body = (await req.json().catch(() => null)) as { answer?: unknown; note?: unknown; model?: unknown } | null;
          const answer = body?.answer;
          const note = typeof body?.note === "string" ? body.note.trim() : "";
          if (answer !== "go" && answer !== "no" && answer !== "redirect") return json({ error: "Answer go, no or redirect." }, 400);
          if (answer === "redirect" && !note) return json({ error: "Say what to do instead." }, 400);
          if (body?.model != null && !isModel(body.model)) return json({ error: `Pick a model: ${MODELS.join(", ")}.` }, 400);
          const item = await readItem(req.params.id, home);
          if (item.status !== "open") return json({ error: `Already answered (${item.status}).` }, 409);
          const model = answerModel(item, answer, isModel(body?.model) ? body.model : null, readCombConfig(home).defaultModel);
          // Deliver first: an answer that never reached the agent leaves the item open.
          const message = answerMessage(item, answer, note || null, model);
          const { woke } = await sendToAgent({ name: item.from, message, fromPage: true, home, claudeBin: claude, run });
          const done = await recordAnswer(item.id, answer, note || null, home, new Date(), model);
          void refresh().catch(() => {});
          return json({ item: done, woke });
        }),
      },
      "/api/tickets/start": {
        POST: (req) => api(req, async () => {
          const body = (await req.json().catch(() => null)) as { project?: unknown; id?: unknown } | null;
          const project = typeof body?.project === "string" ? body.project : "";
          const id = typeof body?.id === "string" ? body.id : "";
          if (!hiveOn) return noHive();
          if (!listHiveProjects(setup.home).includes(project) || !/^[A-Za-z]+-\d+$/.test(id)) return json({ error: "No such ticket." }, 404);
          const t = (await allTickets(false)).tickets.find((x) => x.project === project && x.id === id);
          const who = human(readCombConfig(home));
          const { woke } = await sendToAgent({ name: "maya", message: startTicketMessage(project, id, t?.title ?? null, who), fromPage: true, home, claudeBin: claude, run });
          return json({ woke });
        }),
      },
      "/api/reports": (req) => api(req, async () => {
        const root = join(home, "agents");
        const out: { agent: string; file: string; title: string; summary: string }[] = [];
        for (const agent of existsSync(root) ? readdirSync(root) : []) {
          const dir = join(root, agent, "reports");
          if (!existsSync(dir)) continue;
          for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
            const text = await readFile(join(dir, file), "utf-8");
            const title = text.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? file;
            out.push({ agent, file, title, summary: summaryOf(text) });
          }
        }
        out.sort((a, b) => b.file.localeCompare(a.file));
        return json({ reports: out.slice(0, 8) });
      }),
      "/api/agent/:name/reports": (req) => api(req, async () => {
        const dir = join(agentDir(validateAgentName(req.params.name), home), "reports");
        if (!existsSync(dir)) return json({ reports: [] });
        const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse();
        const reports = await Promise.all(files.map(async (file) => ({ file, text: await readFile(join(dir, file), "utf-8") })));
        return json({ reports });
      }),
      "/api/agent/:name/terminal": {
        // Only a known agent, only `hive attach <name>` (`claude attach` when
        // hive is missing), only in its own
        // directory. The request names the agent and nothing else.
        POST: (req) => api(req, async () => {
          const name = req.params.name;
          const s = /^[a-z][a-z0-9-]{0,39}$/.test(name) ? await readAgentSession(validateAgentName(name), home) : null;
          if (!s) return json({ error: "No such agent." }, 404);
          const dir = agentWorkdir(s);
          if (!dir) return json({ error: `${name}'s directory is gone (${s.cwd}).` }, 409);
          const env: Record<string, string> = {};
          for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
          delete env.ANTHROPIC_API_KEY;
          return json(await openInTerminal({ name, dir, run, rex: rexBin, hive: hiveBin, env }));
        }),
      },
      "/api/agent/:name/:file": (req) => api(req, async () => {
        const file = req.params.file;
        if (!["charter", "checklist", "log"].includes(file)) return json({ error: "No such file." }, 404);
        const path = join(agentDir(validateAgentName(req.params.name), home), `${file}.md`);
        return json({ text: existsSync(path) ? await readFile(path, "utf-8") : "" });
      }),
      "/api/tickets": (req) => api(req, async (url) => hiveOn ? json(await allTickets(url.searchParams.has("fresh"))) : noHive()),
      "/api/ticket": (req) => api(req, async (url) => {
        const project = url.searchParams.get("project") ?? "";
        const id = url.searchParams.get("id") ?? "";
        if (!hiveOn) return noHive();
        if (!listHiveProjects(setup.home).includes(project) || !id) return json({ error: "No such ticket." }, 404);
        return json({ text: await hive.showTicket(project, id) });
      }),
      "/api/usage": (req) => api(req, async () => {
        if (!usageRun && Date.now() - usageAt > USAGE_TTL_MS) void refreshUsage();
        // Nothing read yet: give the first read a moment before saying so.
        if (!usage.ready && usageRun) await Promise.race([usageRun, Bun.sleep(1500)]);
        // Plan limits are one small file, read fresh each time, and shown even while tokens are still being read.
        const limits = await readLimits(opts.limitsPath);
        return json(usage.ready ? { ...usage.summary(), limits, error: usageError } : { ready: false, limits, error: usageError });
      }),
      "/api/pulls": (req) => api(req, async () => json(await pulls.get())),
      "/api/projects": (req) => api(req, () => json({ projects: hiveOn ? listHiveProjects(setup.home) : [] })),
      "/api/memory": (req) => api(req, async (url) => {
        const project = url.searchParams.get("project") ?? "";
        if (!hiveOn) return noHive();
        if (!listHiveProjects(setup.home).includes(project)) return json({ error: "No such project." }, 404);
        return json({ entries: await hive.memory(project) });
      }),
    },
    fetch() {
      return new Response("Not found", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    async stop() {
      clearInterval(timer);
      if (nightlyTimer) clearInterval(nightlyTimer);
      if (pullsTimer) clearInterval(pullsTimer);
      server.stop(true);
      await hive.close();
    },
  };
}

/**
 * What Maya hears when the user clicks Start on a ticket. She routes it; the
 * click is all the input the user gives. Tickets exist only with hive.
 */
export function startTicketMessage(project: string, id: string, title: string | null, who: Human = { name: "the user", Name: "The user" }): string {
  return [
    `Start ${project} ${id}${title ? `, "${title}"` : ""}. ${who.Name} clicked Start on the ticket; that is the go.`,
    `Start a task agent for it in the ${project} repo, on its own worktree, with a charter that holds what it needs: the ticket, your context, and where the design docs and hive memory are.`,
    `Do not come back to ${who.name} first. If something blocks it that only ${who.name} can clear, file it with queue_add.`,
  ].join(" ");
}

/** The first paragraph of a report under its title, in about two lines. */
function summaryOf(text: string): string {
  const para = text.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith("#")) ?? "";
  const flat = para.replace(/^[-*]\s+/gm, "").replace(/\s+/g, " ").replace(/[*_`]/g, "");
  return flat.length > 240 ? flat.slice(0, 239) + "…" : flat;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}
