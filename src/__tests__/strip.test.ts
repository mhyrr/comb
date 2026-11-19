import { describe, expect, test } from "bun:test";

import type { Pull, PullsReport, Readiness } from "../github";
import type { Limits } from "../limits";
import { span, stripFigures, stripHtml, until, type Figure, type StripInput } from "../page/ui/strip";

const now = Date.parse("2026-11-19T21:47:00Z");
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const ahead = (min: number) => new Date(now + min * 60_000).toISOString();

const pull = (readiness: Readiness, n: number): Pull => ({
  project: "acme-api", repo: "acme/api", number: n, title: `PR ${n}`, draft: true, author: "a", bot: false, agent: true,
  head: `worktree-x${n}`, url: `https://github.com/acme/api/pull/${n}`, updated: ago(5), created: ago(60), ci: "passing",
  failing: [], running: [], ciDone: null, review: null, mergeable: "MERGEABLE", mergeState: "CLEAN", readiness,
});
const report = (pulls: Pull[], extra: Partial<PullsReport> = {}): PullsReport =>
  ({ at: ago(1), pulls, bots: [], repos: 2, skipped: [], failed: [], problem: null, refreshing: false, ...extra });
const limits = (session: number | null, opts: { stale?: boolean; resetsIn?: number } = {}): Limits => ({
  status: "ok",
  asOf: ago(opts.stale ? 120 : 3),
  stale: !!opts.stale,
  warning: null,
  windows: [
    { id: "five_hour", label: "Current session", usedPercent: session, resetsAt: ahead(opts.resetsIn ?? 140), reset: session === null },
    { id: "seven_day", label: "Current week (all models)", usedPercent: 61, resetsAt: ahead(3 * 1440), reset: false },
  ],
});

const base = (over: Partial<StripInput> = {}): StripInput => ({
  agents: [
    { name: "maya", activity: "waiting", finished: false },
    { name: "acme-api-tk42", activity: "working", finished: false },
    { name: "docs-search", activity: "asleep", finished: false },
    { name: "web-app-old", activity: "asleep", finished: true },
  ],
  mine: [{ activity: "waiting" }],
  queue: [
    { status: "open", created: ago(40), from: "maya" },
    { status: "open", created: ago(180), from: "docs-search" },
    { status: "approved", created: ago(600), from: "maya" },
  ],
  pulls: { state: "ok", report: report([pull("ready", 12), pull("running", 41), pull("review", 7)]) },
  limits: limits(38),
  now,
  ...over,
});
const fig = (figs: Figure[], key: Figure["key"]) => figs.find((f) => f.key === key);

describe("Now's figure strip", () => {
  test("four figures from the snapshot, the PR report and the limits", () => {
    const f = stripFigures(base());
    expect(f.map((x) => x.key)).toEqual(["working", "waiting", "merge", "limit"]);
    expect(fig(f, "working")).toMatchObject({ value: "1", unit: "of 3 agents", context: "acme-api-tk42", live: true, href: "#/agent/acme-api-tk42" });
    expect(fig(f, "waiting")).toMatchObject({ value: "2", context: "Oldest 3h, from docs-search", jump: "queue" });
    expect(fig(f, "merge")).toMatchObject({ value: "1", unit: "of 3 PRs", context: "1 with CI running, 1 waiting on review or GitHub" });
    expect(fig(f, "limit")).toMatchObject({ value: "38%", unit: "used", context: "Resets in 2h 20m · week 61%", muted: false });
  });

  test("folded agents are not counted, and several working agents are summed up", () => {
    const f = stripFigures(base({
      agents: [
        { name: "a", activity: "working", finished: false },
        { name: "b", activity: "working", finished: false },
        { name: "c", activity: "working", finished: false },
        { name: "gone", activity: "asleep", finished: true },
      ],
      mine: [{ activity: "working" }],
    }));
    expect(fig(f, "working")).toMatchObject({ value: "3", unit: "of 3 agents", context: "a and 2 more · 1 of your sessions too" });
    expect(fig(f, "working")!.href).toBeUndefined();
  });

  test("nothing working and nothing waiting say so in words", () => {
    const f = stripFigures(base({ agents: [{ name: "maya", activity: "waiting", finished: false }], mine: [], queue: [] }));
    expect(fig(f, "working")).toMatchObject({ value: "0", unit: "of 1 agent", context: "No agent is on a turn", live: false });
    expect(fig(f, "waiting")).toMatchObject({ value: "0", context: "Nothing waits on you" });
  });

  test("the waiting figure names the filer the way the page does", () => {
    const f = stripFigures(base({ queue: [{ status: "open", created: ago(90), from: "maya" }], who: (n) => (n === "maya" ? "Maya" : n) }));
    expect(fig(f, "waiting")!.context).toBe("Oldest 2h, from Maya");
  });

  test("without hive there are no PRs, so the strip has three figures", () => {
    const f = stripFigures(base({ pulls: { state: "off" } }));
    expect(f.map((x) => x.key)).toEqual(["working", "waiting", "limit"]);
    expect(stripHtml(f)).toContain('class="strip n3"');
  });

  test("a PR source that is loading, broken or empty says so in its figure", () => {
    expect(fig(stripFigures(base({ pulls: { state: "loading" } })), "merge")).toMatchObject({ value: "…", muted: true });
    expect(fig(stripFigures(base({ pulls: { state: "error", message: "Request failed (500)" } })), "merge"))
      .toMatchObject({ value: "—", context: "Couldn't read pull requests: Request failed (500)", muted: true });
    expect(fig(stripFigures(base({ pulls: { state: "ok", report: report([], { problem: "gh is not installed." }) } })), "merge"))
      .toMatchObject({ value: "—", context: "gh is not installed.", muted: true });
    expect(fig(stripFigures(base({ pulls: { state: "ok", report: report([]) } })), "merge"))
      .toMatchObject({ value: "0", unit: "of 0 PRs", context: "No open pull requests" });
    expect(fig(stripFigures(base({ pulls: { state: "ok", report: report([], { repos: 0, skipped: [{ project: "acme-api", why: "no origin remote" }] }) } })), "merge"))
      .toMatchObject({ value: "—", context: "No project is on GitHub", muted: true });
    expect(fig(stripFigures(base({ pulls: { state: "ok", report: report([], { repos: 0, at: null }) } })), "merge"))
      .toMatchObject({ value: "…", context: "Reading pull requests", muted: true });
    expect(fig(stripFigures(base({ pulls: { state: "ok", report: report([pull("ready", 1), pull("ready", 2)]) } })), "merge"))
      .toMatchObject({ value: "2", context: "All of them" });
  });

  test("limits that are missing, stale or reset say so, in grey", () => {
    expect(fig(stripFigures(base({ limits: undefined })), "limit")).toMatchObject({ value: "…", context: "Reading limits", muted: true });
    expect(fig(stripFigures(base({ limits: { status: "missing", message: "No reading yet. Run comb init --install-statusline." } })), "limit"))
      .toMatchObject({ value: "—", context: "No reading yet. Run comb init --install-statusline.", muted: true });
    expect(fig(stripFigures(base({ limits: limits(38, { stale: true }) })), "limit"))
      .toMatchObject({ value: "38%", context: "Resets in 2h 20m · week 61% · as of 2h ago", muted: true });
    expect(fig(stripFigures(base({ limits: limits(null) })), "limit"))
      .toMatchObject({ value: "—", context: "Reset since the last reading · week 61%", muted: true });
  });

  test("the html escapes what it shows and labels each figure for a screen reader", () => {
    const html = stripHtml(stripFigures(base({ queue: [{ status: "open", created: ago(5), from: "<b>x</b>" }] })));
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain('aria-label="Waiting on you: 1. Oldest 5m, from &lt;b&gt;x&lt;/b&gt;"');
    expect(html).toContain('data-jump="queue"');
    expect(html).toContain('<svg class="strip-hex live"');
  });

  test("spans and countdowns read the way the page says time", () => {
    expect([span(0), span(37 * 60_000), span(3 * 3_600_000), span(60 * 3_600_000)]).toEqual(["1m", "37m", "3h", "3d"]);
    expect([until(45 * 60_000), until(140 * 60_000), until(120 * 60_000), until(27 * 3_600_000)]).toEqual(["45m", "2h 20m", "2h", "1d 3h"]);
  });
});
