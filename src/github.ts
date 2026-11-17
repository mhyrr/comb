/**
 * Open GitHub pull requests in Greg's projects, for the top of the page's Now
 * tab. Review happens on GitHub; the page only links there.
 *
 * Each project's repo comes from `git remote get-url origin` in its path; the
 * PRs from `gh pr list`. Both are read-only, and both run with an argv array,
 * never a shell string. A project with no GitHub remote is skipped and named;
 * a gh failure is reported as one line, never thrown at the page.
 */
import { existsSync } from "node:fs";

import { runProcess, type Run } from "./claude";

export type CiState = "passing" | "failing" | "pending" | "none";

export type Pull = {
  project: string;
  /** owner/name */
  repo: string;
  number: number;
  title: string;
  draft: boolean;
  author: string;
  bot: boolean;
  /** Opened by an agent: Claude Code names its worktree branches worktree-<name>. */
  agent: boolean;
  head: string;
  url: string;
  updated: string;
  created: string;
  ci: CiState;
  /** Names of the checks that failed, for the tooltip. */
  failing: string[];
  /** Names of the checks still running. */
  running: string[];
  /** When the last check finished; null without checks or while one runs. */
  ciDone: string | null;
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null when none is set. */
  review: string | null;
  /** gh's mergeable: MERGEABLE, CONFLICTING or UNKNOWN. */
  mergeable: string;
  /** gh's mergeStateStatus: CLEAN, DIRTY, BLOCKED, BEHIND, UNSTABLE, DRAFT, UNKNOWN… */
  mergeState: string;
  readiness: Readiness;
};

/**
 * Whether Greg could merge the PR now, which is what the badge's color says:
 *   ready      green  CI passed or the repo has none, no conflicts, no review holding it
 *   failing    red    a check failed
 *   conflicts  red    the branch conflicts with its base
 *   running    amber  a check is still running
 *   review     grey   a required review is missing, or changes were requested
 *   unknown    grey   GitHub has not worked out mergeability yet
 * Draft never matters: every agent PR is a draft, and drafts are what Greg reviews.
 */
export type Readiness = "ready" | "failing" | "conflicts" | "running" | "review" | "unknown";

export function readinessOf(p: { ci: CiState; mergeable: string; mergeState: string; review: string | null }): Readiness {
  if (p.ci === "failing") return "failing";
  if (p.mergeable === "CONFLICTING" || p.mergeState === "DIRTY") return "conflicts";
  if (p.ci === "pending") return "running";
  if (p.mergeable !== "MERGEABLE" || p.mergeState === "UNKNOWN" || !p.mergeState) return "unknown";
  if (p.review === "REVIEW_REQUIRED" || p.review === "CHANGES_REQUESTED" || p.mergeState === "BLOCKED") return "review";
  return "ready";
}

export type BotGroup = { project: string; repo: string; pulls: Pull[] };

export type PullsReport = {
  /** When the last refresh finished; null before the first one. */
  at: string | null;
  /** Agent and human PRs: agent ones first, then the most recently updated. */
  pulls: Pull[];
  /** Dependabot and other bot PRs, one group per repo. */
  bots: BotGroup[];
  /** How many repos were read. */
  repos: number;
  /** Projects with no GitHub origin, and why. */
  skipped: { project: string; why: string }[];
  /** Repos gh could not read. */
  failed: { project: string; repo: string; error: string }[];
  /** gh missing, or every repo failed: one line for the page. */
  problem: string | null;
  refreshing: boolean;
};

/**
 * owner/name from a git remote URL on github.com, or null for any other host.
 * Handles git@github.com:o/r.git, ssh://git@github.com/o/r, https://github.com/o/r(.git).
 */
export function parseGithubRemote(url: string): string | null {
  const u = url.trim();
  const m =
    u.match(/^(?:[\w.-]+@)?github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/) ??
    u.match(/^(?:ssh|https?|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The GitHub repo a project lives in, or why it has none. */
export async function repoForPath(path: string, run: Run = runProcess): Promise<{ repo: string } | { why: string }> {
  if (!existsSync(path)) return { why: `no folder at ${path}` };
  let res;
  try {
    res = await run(["git", "-C", path, "remote", "get-url", "origin"], { cwd: path, env: plainEnv() });
  } catch (err) {
    return { why: `git failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (res.code !== 0) return { why: "no origin remote" };
  const repo = parseGithubRemote(res.stdout);
  return repo ? { repo } : { why: "origin is not on github.com" };
}

/** A finished check run with one of these conclusions failed. */
const FAILED = ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"];

/** CI from gh's statusCheckRollup: any failure fails; anything unfinished is pending. */
export function ciOf(rollup: unknown): CiState {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let pending = false;
  for (const c of rollup as Record<string, unknown>[]) {
    if (c?.__typename === "StatusContext") {
      const s = String(c.state ?? "");
      if (s === "FAILURE" || s === "ERROR") return "failing";
      if (s !== "SUCCESS") pending = true;
      continue;
    }
    if (c?.status !== "COMPLETED") { pending = true; continue; }
    const k = String(c.conclusion ?? "");
    if (FAILED.includes(k)) return "failing";
  }
  return pending ? "pending" : "passing";
}

/** The failing and running checks by name, and when the last one finished (null while any runs). */
export function checksOf(rollup: unknown): { failing: string[]; running: string[]; done: string | null } {
  const failing: string[] = [];
  const running: string[] = [];
  let done: string | null = null;
  for (const c of Array.isArray(rollup) ? (rollup as Record<string, unknown>[]) : []) {
    const name = String(c?.name ?? c?.context ?? "check");
    if (c?.__typename === "StatusContext") {
      const s = String(c.state ?? "");
      if (s === "FAILURE" || s === "ERROR") failing.push(name);
      else if (s !== "SUCCESS") running.push(name);
      continue;
    }
    if (c?.status !== "COMPLETED") { running.push(name); continue; }
    if (FAILED.includes(String(c.conclusion ?? ""))) failing.push(name);
    const at = typeof c.completedAt === "string" ? c.completedAt : null;
    if (at && (!done || at > done)) done = at;
  }
  return { failing, running, done: running.length ? null : done };
}

const FIELDS = "number,title,isDraft,author,headRefName,url,createdAt,updatedAt,statusCheckRollup,reviewDecision,mergeable,mergeStateStatus";

type GhPull = {
  number: number;
  title: string;
  isDraft: boolean;
  author?: { login?: string; is_bot?: boolean } | null;
  headRefName: string;
  url: string;
  createdAt?: string;
  updatedAt: string;
  statusCheckRollup?: unknown;
  reviewDecision?: string | null;
  mergeable?: string | null;
  mergeStateStatus?: string | null;
};

const isBot = (a: GhPull["author"]) =>
  !!a?.is_bot || /\[bot\]$/.test(a?.login ?? "") || (a?.login ?? "").startsWith("app/");

/** One row of `gh pr list --json` as a Pull. */
export function toPull(project: string, repo: string, p: GhPull): Pull {
  const login = p.author?.login ?? "";
  const ci = ciOf(p.statusCheckRollup);
  const checks = checksOf(p.statusCheckRollup);
  const review = p.reviewDecision || null;
  const mergeable = p.mergeable || "UNKNOWN";
  const mergeState = p.mergeStateStatus || "UNKNOWN";
  return {
    project,
    repo,
    number: p.number,
    title: p.title,
    draft: !!p.isDraft,
    author: login.replace(/^app\//, ""),
    bot: isBot(p.author),
    agent: p.headRefName.startsWith("worktree-"),
    head: p.headRefName,
    url: p.url,
    created: p.createdAt || p.updatedAt,
    updated: p.updatedAt,
    ci,
    failing: checks.failing,
    running: checks.running,
    ciDone: checks.done,
    review,
    mergeable,
    mergeState,
    readiness: readinessOf({ ci, mergeable, mergeState, review }),
  };
}

/** Open PRs in one repo. Throws with gh's own message when it fails. */
export async function listPulls(gh: string, project: string, repo: string, run: Run = runProcess): Promise<Pull[]> {
  const argv = [gh, "pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", FIELDS];
  const res = await withTimeout(run(argv, { cwd: process.env.HOME || "/", env: plainEnv() }), GH_TIMEOUT_MS, `gh timed out after ${GH_TIMEOUT_MS / 1000}s`);
  if (res.code !== 0) throw new Error(firstLine(res.stderr) || firstLine(res.stdout) || `gh exited ${res.code}`);
  const rows = JSON.parse(res.stdout) as GhPull[];
  if (!Array.isArray(rows)) throw new Error("gh pr list did not return a list");
  return rows.map((p) => toPull(project, repo, p));
}

/** Agent PRs first, then human ones, newest first; bot PRs grouped per repo. */
export function groupPulls(all: Pull[]): { pulls: Pull[]; bots: BotGroup[] } {
  const pulls = all.filter((p) => !p.bot).sort((a, b) =>
    Number(b.agent) - Number(a.agent) || b.updated.localeCompare(a.updated) || a.repo.localeCompare(b.repo) || b.number - a.number);
  const groups = new Map<string, BotGroup>();
  for (const p of all.filter((x) => x.bot)) {
    const g = groups.get(p.repo) ?? { project: p.project, repo: p.repo, pulls: [] };
    g.pulls.push(p);
    groups.set(p.repo, g);
  }
  const bots = [...groups.values()];
  for (const g of bots) g.pulls.sort((a, b) => b.updated.localeCompare(a.updated));
  bots.sort((a, b) => b.pulls.length - a.pulls.length || a.repo.localeCompare(b.repo));
  return { pulls, bots };
}

/**
 * What the page gets: bot PRs only when `showBots` (config.json's
 * pullsShowBots) is on. gh still reads them; the strip leaves them out.
 */
export function forPage(r: PullsReport, showBots: boolean): PullsReport {
  return showBots ? r : { ...r, bots: [] };
}

/** gh on PATH, else where Homebrew and the installer put it. Null when none. */
export function findGhBin(exists: (p: string) => boolean = existsSync): string | null {
  if (process.env.COMB_GH_BIN) return process.env.COMB_GH_BIN;
  const onPath = Bun.which("gh");
  if (onPath) return onPath;
  for (const p of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) if (exists(p)) return p;
  return null;
}

/** Reads every project's PRs, a few repos at a time. Never throws. */
export async function readPulls(o: {
  projects: { name: string; path: string }[];
  gh: string | null;
  run?: Run;
}): Promise<Omit<PullsReport, "refreshing">> {
  const run = o.run ?? runProcess;
  const at = new Date().toISOString();
  const empty = { at, pulls: [], bots: [], repos: 0, skipped: [], failed: [] };
  if (!o.gh) return { ...empty, problem: "gh is not installed, so pull requests can't be read." };

  const skipped: PullsReport["skipped"] = [];
  const targets: { project: string; repo: string }[] = [];
  const seen = new Set<string>();
  const found = await Promise.all(o.projects.map(async (p) => ({ p, r: await repoForPath(p.path, run) })));
  for (const { p, r } of found) {
    if ("why" in r) { skipped.push({ project: p.name, why: r.why }); continue; }
    if (seen.has(r.repo)) continue; // two projects in one repo: read it once
    seen.add(r.repo);
    targets.push({ project: p.name, repo: r.repo });
  }

  const failed: PullsReport["failed"] = [];
  const all: Pull[] = [];
  await pool(targets, 4, async (t) => {
    try {
      all.push(...await listPulls(o.gh!, t.project, t.repo, run));
    } catch (err) {
      failed.push({ ...t, error: err instanceof Error ? err.message : String(err) });
    }
  });
  failed.sort((a, b) => a.repo.localeCompare(b.repo));
  const problem = targets.length > 0 && failed.length === targets.length
    ? `gh could not read any repo: ${failed[0]!.error.replace(/\.?$/, ".")}`
    : null;
  return { at, ...groupPulls(all), repos: targets.length, skipped, failed, problem };
}

/**
 * The page's cache of open PRs. `get` answers at once with what it has and
 * refreshes in the background when the cache is older than `ttlMs`; only the
 * very first read waits for gh. One refresh runs at a time.
 */
export class PullWatch {
  private last: Omit<PullsReport, "refreshing"> | null = null;
  private inflight: Promise<void> | null = null;
  private lastAt = 0;

  constructor(private o: {
    projects: () => { name: string; path: string }[];
    gh: string | null;
    run?: Run;
    ttlMs: number;
    now?: () => number;
  }) {}

  private now() { return this.o.now?.() ?? Date.now(); }

  refresh(): Promise<void> {
    if (!this.inflight) {
      this.inflight = (async () => {
        try {
          this.last = await readPulls({ projects: this.o.projects(), gh: this.o.gh, run: this.o.run });
        } catch (err) {
          // readPulls catches per repo; this is a bug or a broken registry. Say so, keep the old rows.
          const problem = `Couldn't read pull requests: ${err instanceof Error ? err.message : String(err)}`;
          this.last = this.last ? { ...this.last, problem } : { at: new Date().toISOString(), pulls: [], bots: [], repos: 0, skipped: [], failed: [], problem };
        }
        this.lastAt = this.now();
      })().finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  stale(): boolean {
    return !this.last || this.now() - this.lastAt >= this.o.ttlMs;
  }

  async get(): Promise<PullsReport> {
    if (!this.last) await this.refresh();
    else if (this.stale()) void this.refresh();
    return { ...this.last!, refreshing: this.inflight !== null };
  }
}

const GH_TIMEOUT_MS = 30_000;

async function pool<T>(items: T[], size: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}

function withTimeout<T>(p: Promise<T>, ms: number, why: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => { t = setTimeout(() => reject(new Error(why)), ms); }),
  ]);
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0]?.trim() ?? "";
}

function plainEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.GH_PROMPT_DISABLED = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}
