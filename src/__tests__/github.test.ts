import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Run } from "../claude";
import { checksOf, ciOf, forPage, groupPulls, readinessOf, parseGithubRemote, PullWatch, readPulls, repoForPath, toPull, type Pull, type PullsReport } from "../github";
import { hiveProjectPaths } from "../hive";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "comb-gh-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** A fake runner: `git remote get-url` answers from `remotes` by path; `gh` from `gh` by repo. */
function fakeRun(remotes: Record<string, string | null>, gh: Record<string, unknown[] | string>) {
  const calls: string[][] = [];
  const run: Run = async (argv) => {
    calls.push(argv);
    if (argv[0] === "git") {
      const url = remotes[argv[2]!];
      return url ? { code: 0, stdout: url + "\n", stderr: "" } : { code: 2, stdout: "", stderr: "error: No such remote 'origin'" };
    }
    const repo = argv[argv.indexOf("--repo") + 1]!;
    const out = gh[repo];
    if (typeof out === "string") return { code: 1, stdout: "", stderr: out + "\nmore detail" };
    return { code: 0, stdout: JSON.stringify(out ?? []), stderr: "" };
  };
  return { run, calls };
}

const ghPull = (n: number, o: Partial<{ login: string; bot: boolean; head: string; updated: string; draft: boolean; rollup: unknown[] }> = {}) => ({
  number: n,
  title: `PR ${n}`,
  isDraft: o.draft ?? false,
  author: { login: o.login ?? "mhyrr", is_bot: o.bot ?? false },
  headRefName: o.head ?? `feature-${n}`,
  url: `https://github.com/x/y/pull/${n}`,
  updatedAt: o.updated ?? "2026-11-17T10:00:00Z",
  statusCheckRollup: o.rollup ?? [],
  reviewDecision: "",
});

describe("parseGithubRemote", () => {
  test("reads ssh and https remotes on github.com", () => {
    expect(parseGithubRemote("git@github.com:mhyrr/revrec.git")).toBe("mhyrr/revrec");
    expect(parseGithubRemote("git@github.com:mhyrr/math_eval")).toBe("mhyrr/math_eval");
    expect(parseGithubRemote("ssh://git@github.com/mhyrr/dobby.git")).toBe("mhyrr/dobby");
    expect(parseGithubRemote("https://github.com/mhyrr/seodash.git\n")).toBe("mhyrr/seodash");
    expect(parseGithubRemote("https://github.com/some-org/a.b-c")).toBe("some-org/a.b-c");
    expect(parseGithubRemote("https://token@github.com/mhyrr/arete/")).toBe("mhyrr/arete");
  });

  test("anything not on github.com is null", () => {
    expect(parseGithubRemote("git@gitlab.com:mhyrr/revrec.git")).toBeNull();
    expect(parseGithubRemote("https://github.company.com/a/b.git")).toBeNull();
    expect(parseGithubRemote("https://notgithub.com/a/b")).toBeNull();
    expect(parseGithubRemote("/Users/mhyrr/repos/bare.git")).toBeNull();
    expect(parseGithubRemote("")).toBeNull();
  });
});

describe("repoForPath", () => {
  test("a project with no origin, a missing folder and another host are skipped with a reason", async () => {
    const { run } = fakeRun({ [dir]: null }, {});
    expect(await repoForPath(dir, run)).toEqual({ why: "no origin remote" });
    expect(await repoForPath(join(dir, "gone"), run)).toEqual({ why: `no folder at ${join(dir, "gone")}` });
    const other = fakeRun({ [dir]: "git@gitlab.com:a/b.git" }, {});
    expect(await repoForPath(dir, other.run)).toEqual({ why: "origin is not on github.com" });
  });

  test("runs git with an argv array in the project's folder", async () => {
    const { run, calls } = fakeRun({ [dir]: "git@github.com:mhyrr/revrec.git" }, {});
    expect(await repoForPath(dir, run)).toEqual({ repo: "mhyrr/revrec" });
    expect(calls[0]).toEqual(["git", "-C", dir, "remote", "get-url", "origin"]);
  });
});

describe("ciOf", () => {
  const run = (status: string, conclusion: string | null) => ({ __typename: "CheckRun", status, conclusion });
  test("any failure fails, anything unfinished is pending, else passing", () => {
    expect(ciOf([])).toBe("none");
    expect(ciOf(undefined)).toBe("none");
    expect(ciOf([run("COMPLETED", "SUCCESS"), run("COMPLETED", "SKIPPED")])).toBe("passing");
    expect(ciOf([run("COMPLETED", "SUCCESS"), run("IN_PROGRESS", null)])).toBe("pending");
    expect(ciOf([run("IN_PROGRESS", null), run("COMPLETED", "FAILURE")])).toBe("failing");
    expect(ciOf([run("COMPLETED", "TIMED_OUT")])).toBe("failing");
    expect(ciOf([{ __typename: "StatusContext", state: "PENDING" }])).toBe("pending");
    expect(ciOf([{ __typename: "StatusContext", state: "ERROR" }])).toBe("failing");
  });
});

describe("readinessOf: the badge's color", () => {
  const CIS = ["passing", "failing", "pending", "none"] as const;
  const MERGEABLE = ["MERGEABLE", "CONFLICTING", "UNKNOWN"];
  const STATES = ["CLEAN", "DIRTY", "BLOCKED", "BEHIND", "UNSTABLE", "DRAFT", "HAS_HOOKS", "UNKNOWN", ""];
  const REVIEWS = [null, "APPROVED", "REVIEW_REQUIRED", "CHANGES_REQUESTED"];

  /** The rules as Greg gave them, written out case by case, apart from the code. */
  function expected(ci: string, mergeable: string, state: string, review: string | null): string {
    const conflicts = mergeable === "CONFLICTING" || state === "DIRTY";
    if (ci === "failing") return "failing";
    if (conflicts) return "conflicts";
    if (ci === "pending") return "running";
    const known = mergeable === "MERGEABLE" && state !== "UNKNOWN" && state !== "";
    if (!known) return "unknown";
    const held = review === "REVIEW_REQUIRED" || review === "CHANGES_REQUESTED" || state === "BLOCKED";
    return held ? "review" : "ready";
  }

  test("every combination of CI, mergeable, merge state and review", () => {
    let n = 0;
    for (const ci of CIS) for (const mergeable of MERGEABLE) for (const mergeState of STATES) for (const review of REVIEWS) {
      expect([ci, mergeable, mergeState, review, readinessOf({ ci, mergeable, mergeState, review })])
        .toEqual([ci, mergeable, mergeState, review, expected(ci, mergeable, mergeState, review)]);
      n++;
    }
    expect(n).toBe(4 * 3 * 9 * 4);
  });

  test("the cases Greg named", () => {
    const r = (o: Partial<Parameters<typeof readinessOf>[0]>) =>
      readinessOf({ ci: "passing", mergeable: "MERGEABLE", mergeState: "CLEAN", review: null, ...o });
    expect(r({})).toBe("ready");
    expect(r({ ci: "none" })).toBe("ready"); // no CI is not its own color
    expect(r({ mergeState: "BEHIND" })).toBe("ready"); // behind its base still merges
    expect(r({ ci: "failing" })).toBe("failing");
    expect(r({ mergeable: "CONFLICTING", mergeState: "DIRTY" })).toBe("conflicts");
    expect(r({ ci: "failing", mergeable: "CONFLICTING" })).toBe("failing");
    expect(r({ ci: "pending" })).toBe("running");
    expect(r({ mergeable: "UNKNOWN", mergeState: "UNKNOWN" })).toBe("unknown");
    expect(r({ review: "REVIEW_REQUIRED", mergeState: "BLOCKED" })).toBe("review");
    expect(r({ review: "APPROVED" })).toBe("ready");
  });

  test("a draft agent PR with green CI is green: draft never matters", () => {
    const p = toPull("dobby", "mhyrr/dobby", {
      ...ghPull(29, { head: "worktree-dobby-tk-042", draft: true, rollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-11-17T14:53:24Z" }] }),
      mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", createdAt: "2026-11-17T14:50:55Z",
    });
    expect([p.draft, p.readiness, p.ciDone, p.created]).toEqual([true, "ready", "2026-11-17T14:53:24Z", "2026-11-17T14:50:55Z"]);
  });

  test("a row without merge fields reads as unknown, not ready", () => {
    expect(toPull("x", "o/x", ghPull(1)).readiness).toBe("unknown");
  });
});

describe("checksOf", () => {
  test("names failing and running checks; the finish time only once all are done", () => {
    const done = (name: string, conclusion: string, completedAt: string) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion, completedAt });
    expect(checksOf([done("ci", "SUCCESS", "2026-11-17T10:00:00Z"), done("lint", "SUCCESS", "2026-11-17T11:00:00Z")]))
      .toEqual({ failing: [], running: [], done: "2026-11-17T11:00:00Z" });
    expect(checksOf([done("ci", "FAILURE", "2026-11-17T10:00:00Z"), done("test", "TIMED_OUT", "2026-11-17T10:05:00Z")]))
      .toEqual({ failing: ["ci", "test"], running: [], done: "2026-11-17T10:05:00Z" });
    expect(checksOf([done("ci", "SUCCESS", "2026-11-17T10:00:00Z"), { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS" }]))
      .toEqual({ failing: [], running: ["e2e"], done: null });
    expect(checksOf([{ __typename: "StatusContext", context: "deploy/preview", state: "ERROR" }]))
      .toEqual({ failing: ["deploy/preview"], running: [], done: null });
    expect(checksOf(undefined)).toEqual({ failing: [], running: [], done: null });
  });
});

describe("forPage", () => {
  test("bot PRs leave the strip unless pullsShowBots is on; people's and agents' PRs stay", () => {
    const human = toPull("dobby", "mhyrr/dobby", ghPull(28, { head: "worktree-dobby-tk070" }));
    const bot = toPull("revrec", "mhyrr/revrec", ghPull(113, { login: "app/dependabot", bot: true }));
    const report: PullsReport = {
      at: "2026-11-17T20:00:00Z", ...groupPulls([human, bot]), repos: 2, skipped: [], failed: [], problem: null, refreshing: false,
    };
    const off = forPage(report, false);
    expect(off.bots).toEqual([]);
    expect(off.pulls.map((p) => p.number)).toEqual([28]);
    expect(off.repos).toBe(2);
    expect(forPage(report, true).bots.map((g) => g.pulls.map((p) => p.number))).toEqual([[113]]);
  });
});

describe("groupPulls", () => {
  test("bots go in one group per repo; agent PRs come first, then the newest", () => {
    const pulls: Pull[] = [
      toPull("revrec", "mhyrr/revrec", ghPull(113, { login: "app/dependabot", bot: true, updated: "2026-11-10T00:00:00Z" })),
      toPull("revrec", "mhyrr/revrec", ghPull(112, { login: "app/dependabot", bot: true, updated: "2026-11-12T00:00:00Z" })),
      toPull("seodash", "mhyrr/seodash", ghPull(9, { login: "renovate[bot]", bot: false })),
      toPull("dobby", "mhyrr/dobby", ghPull(30, { head: "fix-by-hand", updated: "2026-11-17T12:00:00Z" })),
      toPull("dobby", "mhyrr/dobby", ghPull(28, { head: "worktree-dobby-tk070", updated: "2026-11-16T00:00:00Z" })),
      toPull("arete", "mhyrr/arete", ghPull(1, { head: "worktree-arete-tk-031", updated: "2026-11-17T09:00:00Z" })),
    ];
    const { pulls: main, bots } = groupPulls(pulls);
    expect(main.map((p) => `${p.project}#${p.number}`)).toEqual(["arete#1", "dobby#28", "dobby#30"]);
    expect(main.every((p) => !p.bot)).toBe(true);
    expect(bots.map((g) => [g.repo, g.pulls.map((p) => p.number)])).toEqual([
      ["mhyrr/revrec", [112, 113]],
      ["mhyrr/seodash", [9]],
    ]);
    expect(bots[0]!.pulls[0]!.author).toBe("dependabot");
  });
});

describe("readPulls", () => {
  const projects = () => [
    { name: "dobby", path: join(dir, "dobby") },
    { name: "writing", path: join(dir, "writing") },
    { name: "revrec", path: join(dir, "revrec") },
  ];
  beforeEach(async () => {
    for (const p of ["dobby", "writing", "revrec"]) await mkdir(join(dir, p));
  });

  test("names skipped projects and keeps reading the rest", async () => {
    const { run } = fakeRun(
      { [join(dir, "dobby")]: "git@github.com:mhyrr/dobby.git", [join(dir, "writing")]: null, [join(dir, "revrec")]: "git@github.com:mhyrr/revrec.git" },
      { "mhyrr/dobby": [ghPull(29, { head: "worktree-dobby-tk-042", draft: true })], "mhyrr/revrec": [ghPull(110, { login: "app/dependabot", bot: true })] },
    );
    const r = await readPulls({ projects: projects(), gh: "gh", run });
    expect(r.problem).toBeNull();
    expect(r.repos).toBe(2);
    expect(r.skipped).toEqual([{ project: "writing", why: "no origin remote" }]);
    expect(r.pulls.map((p) => [p.repo, p.number, p.draft, p.agent])).toEqual([["mhyrr/dobby", 29, true, true]]);
    expect(r.bots.map((g) => g.pulls.length)).toEqual([1]);
  });

  test("gh failing on one repo is named; failing on every repo is the page's one line", async () => {
    const remotes = { [join(dir, "dobby")]: "git@github.com:mhyrr/dobby.git", [join(dir, "revrec")]: "git@github.com:mhyrr/revrec.git" };
    const one = await readPulls({ projects: projects(), gh: "gh", run: fakeRun(remotes, { "mhyrr/revrec": "GraphQL: Could not resolve to a Repository" }).run });
    expect(one.problem).toBeNull();
    expect(one.failed).toEqual([{ project: "revrec", repo: "mhyrr/revrec", error: "GraphQL: Could not resolve to a Repository" }]);

    const auth = "To get started with GitHub CLI, please run:  gh auth login";
    const all = await readPulls({ projects: projects(), gh: "gh", run: fakeRun(remotes, { "mhyrr/dobby": auth, "mhyrr/revrec": auth }).run });
    expect(all.problem).toBe(`gh could not read any repo: ${auth}.`);
    expect(all.pulls).toEqual([]);
  });

  test("a runner that throws is a failed repo, not a thrown page", async () => {
    const run: Run = async (argv) => {
      if (argv[0] === "git") return { code: 0, stdout: "git@github.com:mhyrr/dobby.git", stderr: "" };
      throw new Error("spawn gh ENOENT");
    };
    const r = await readPulls({ projects: [projects()[0]!], gh: "gh", run });
    expect(r.problem).toBe("gh could not read any repo: spawn gh ENOENT.");
  });

  test("no gh at all says so without running anything", async () => {
    const { run, calls } = fakeRun({}, {});
    const r = await readPulls({ projects: projects(), gh: null, run });
    expect(r.problem).toBe("gh is not installed, so pull requests can't be read.");
    expect(calls).toEqual([]);
  });

  test("gh is called read-only, with an argv array", async () => {
    const { run, calls } = fakeRun({ [join(dir, "dobby")]: "git@github.com:mhyrr/dobby.git" }, {});
    await readPulls({ projects: [projects()[0]!], gh: "/opt/homebrew/bin/gh", run });
    const gh = calls.find((c) => c[0] === "/opt/homebrew/bin/gh")!;
    expect(gh.slice(1, 7)).toEqual(["pr", "list", "--repo", "mhyrr/dobby", "--state", "open"]);
  });
});

describe("PullWatch", () => {
  test("the first read waits; a stale read answers at once and refreshes behind", async () => {
    await mkdir(join(dir, "dobby"));
    let t = 0;
    let n = 0;
    const run: Run = async (argv) => {
      if (argv[0] === "git") return { code: 0, stdout: "git@github.com:mhyrr/dobby.git", stderr: "" };
      n++;
      return { code: 0, stdout: JSON.stringify(Array.from({ length: n }, (_, i) => ghPull(i + 1))), stderr: "" };
    };
    const w = new PullWatch({ projects: () => [{ name: "dobby", path: join(dir, "dobby") }], gh: "gh", run, ttlMs: 1000, now: () => t });
    expect((await w.get()).pulls.length).toBe(1);
    t = 500;
    expect((await w.get()).pulls.length).toBe(1);
    expect(n).toBe(1);
    t = 2000;
    const stale = await w.get();
    expect(stale.pulls.length).toBe(1);
    expect(stale.refreshing).toBe(true);
    await w.refresh();
    expect((await w.get()).pulls.length).toBe(2);
  });
});

describe("hiveProjectPaths", () => {
  test("lists each project's path and skips ones without one", async () => {
    const hive = join(dir, "hive");
    await mkdir(join(hive, "projects", "dobby"), { recursive: true });
    await mkdir(join(hive, "projects", "nopath"), { recursive: true });
    await writeFile(join(hive, "projects", "dobby", "config.md"), "name: dobby\npath: /work/dobby\n");
    await writeFile(join(hive, "projects", "nopath", "config.md"), "name: nopath\n");
    expect(hiveProjectPaths(hive)).toEqual([{ name: "dobby", path: "/work/dobby" }]);
  });
});
