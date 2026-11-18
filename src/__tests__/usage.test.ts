import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { existsSync } from "node:fs";

import type { HiveClient } from "../hive";
import type { Limits } from "../limits";
import { startPage } from "../page/server";
import { priceOf, rateFor } from "../pricing";
import { codexStart, parseClaudeLine, parseCodexLine, parseGeminiChat, UsageIndex, type Roots, type UsageSummary } from "../usage";
import { compact, familyOf, modelName, usageHtml } from "../page/ui/usage";

// A fixed "now": noon, local time, so day buckets never straddle midnight.
const NOW = new Date(2026, 10, 17, 12, 0, 0).getTime();
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();
const line = (o: object) => JSON.stringify(o) + "\n";

const claudeMsg = (id: string, hoursAgo: number, usage: object, extra: object = {}) => line({
  type: "assistant",
  sessionId: "s1",
  timestamp: at(hoursAgo),
  message: { id, model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "private words" }], usage },
  ...extra,
});
const usage = (output: number, more: object = {}) =>
  ({ input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: output, ...more });

const codexCount = (hoursAgo: number, input: number, cached: number, output: number) => line({
  timestamp: at(hoursAgo),
  type: "event_msg",
  payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output } } },
});

let dir: string;
let roots: Roots;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "comb-usage-"));
  roots = {
    claude: join(dir, ".claude", "projects"),
    codex: join(dir, ".codex", "sessions"),
    gemini: join(dir, ".gemini", "tmp"),
    cursor: [join(dir, ".cursor")],
  };
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const index = (cachePath: string | null = null) => new UsageIndex({ roots, cachePath, now: () => NOW });

describe("parsers", () => {
  test("Claude: an assistant line becomes counts only, with the 1-hour cache writes split out", () => {
    const r = parseClaudeLine(claudeMsg("m1", 1, usage(50, {
      cache_creation: { ephemeral_1h_input_tokens: 60, ephemeral_5m_input_tokens: 40 },
      output_tokens_details: { thinking_tokens: 20 },
    })).trim(), "file")!;
    expect(r).toMatchObject({ id: "m1", model: "claude-opus-5-5", session: "s1", input: 10, write5m: 40, write1h: 60, read: 1000, output: 50, thinking: 20 });
    expect(JSON.stringify(r)).not.toContain("private words");
  });

  test("Claude: user lines, synthetic messages and lines without usage are not records", () => {
    expect(parseClaudeLine(line({ type: "user", message: { content: "hi" } }).trim(), "f")).toBeNull();
    expect(parseClaudeLine(line({ type: "user", message: { content: 'the word "usage" in a tool result' } }).trim(), "f")).toBeNull();
    const synthetic = JSON.parse(claudeMsg("m2", 1, usage(0)));
    synthetic.message.model = "<synthetic>";
    expect(parseClaudeLine(JSON.stringify(synthetic), "f")).toBeNull();
  });

  test("Codex: cumulative totals become steps; a repeated event counts once", () => {
    const st = codexStart("file");
    expect(parseCodexLine(line({ type: "session_meta", payload: { id: "sess" } }).trim(), st)).toBeNull();
    expect(parseCodexLine(line({ type: "turn_context", payload: { model: "gpt-6.1-sol" } }).trim(), st)).toBeNull();
    const a = parseCodexLine(codexCount(2, 1000, 800, 50).trim(), st)!;
    const repeat = parseCodexLine(codexCount(2, 1000, 800, 50).trim(), st);
    const b = parseCodexLine(codexCount(1, 1500, 1200, 80).trim(), st)!;
    expect(a).toMatchObject({ id: "sess:1050", model: "gpt-6.1-sol", input: 200, read: 800, output: 50 });
    expect(repeat).toBeNull();
    expect(b).toMatchObject({ input: 100, read: 400, output: 30 });
  });

  test("Gemini: thoughts count as output; cached input is the cache's slice", () => {
    const recs = parseGeminiChat(JSON.stringify({
      sessionId: "g1",
      messages: [
        { id: "u", type: "user", timestamp: at(1), content: "secret" },
        { id: "x", type: "gemini", timestamp: at(1), model: "gemini-3-flash-preview", tokens: { input: 7843, output: 45, cached: 6844, thoughts: 43, tool: 0, total: 7931 } },
      ],
    }), "f");
    expect(recs).toEqual([{ id: "g1:x", ts: Date.parse(at(1)), model: "gemini-3-flash-preview", session: "g1", input: 999, write5m: 0, write1h: 0, read: 6844, output: 88, thinking: 43 }]);
  });
});

describe("pricing", () => {
  test("a dated snapshot or 1M variant prices as its model; Haiku 5.5 and unknown models do not price", () => {
    expect(rateFor("claude-haiku-4-5-20251001")).toEqual(rateFor("claude-haiku-4-5"));
    expect(rateFor("claude-opus-5-5[1m]")).toEqual(rateFor("claude-opus-5-5"));
    expect(rateFor("claude-haiku-5-5")).toBeNull();
    expect(rateFor("gpt-6.1-sol")).toBeNull();
    // Opus 5.5: $4 in, $5 5m write, $8 1h write, $0.20 read, $20 out, per million.
    expect(priceOf({ input: 1e6, write5m: 1e6, write1h: 1e6, read: 1e6, output: 1e6 }, rateFor("claude-opus-5-5")!)).toBeCloseTo(37.2, 6);
  });
});

describe("UsageIndex", () => {
  async function claudeFile(name: string, text: string) {
    const p = join(roots.claude, "-proj", name);
    await mkdir(join(roots.claude, "-proj"), { recursive: true });
    await writeFile(p, text);
    return p;
  }

  test("dedupes repeated lines and resumed copies, skips a malformed line, and counts today and the week", async () => {
    const msg = claudeMsg("m1", 1, usage(50));
    await claudeFile("a.jsonl", msg + msg + "{not json, but it has \"usage\"\n" + claudeMsg("m2", 3 * 24, usage(70)));
    await claudeFile("b.jsonl", msg); // a resumed session repeats m1
    const ix = index();
    await ix.refresh();
    const s = ix.summary();
    expect(s.claude.today.output).toBe(50);
    expect(s.claude.today.calls).toBe(1);
    expect(s.claude.week.output).toBe(120);
    expect(s.claude.days).toHaveLength(30);
    expect(s.claude.days.at(-1)!.output).toBe(50);
    expect(s.claude.models).toHaveLength(1);
    expect(s.claude.models[0]).toMatchObject({ model: "claude-opus-5-5", output: 120, tokens: 1160 + 1180 });
    // m1: 10×$4 + 100×$5 + 1000×$0.20 + 50×$20 = $1,740 per million; m2 the same with 70 out, $2,140.
    expect(s.claude.week.usd).toBeCloseTo(0.00388, 9);
    expect(s.harnesses.find((h) => h.id === "claude")!.note).toBe("1 unreadable line skipped.");
  });

  test("a line still being written is left for the next read", async () => {
    const p = await claudeFile("a.jsonl", claudeMsg("m1", 1, usage(50)) + claudeMsg("m2", 1, usage(7)).trim());
    const ix = index();
    await ix.refresh();
    expect(ix.summary().claude.today.output).toBe(50);
    await appendFile(p, "\n");
    await ix.refresh();
    expect(ix.summary().claude.today.output).toBe(57);
  });

  test("cache: an unchanged file is not read again; an appended one is; a rewritten one is read whole", async () => {
    const p = await claudeFile("a.jsonl", claudeMsg("m1", 1, usage(50)));
    await claudeFile("b.jsonl", claudeMsg("m9", 1, usage(1)));
    const ix = index();
    await ix.refresh();
    expect(ix.lastRead).toHaveLength(2);

    await ix.refresh();
    expect(ix.lastRead).toEqual([]);

    await appendFile(p, claudeMsg("m2", 1, usage(5)));
    await ix.refresh();
    expect(ix.lastRead).toEqual([p]);
    expect(ix.summary().claude.today.output).toBe(56);

    // Shorter than before: rewritten, so its old records go.
    await writeFile(p, claudeMsg("m3", 1, usage(2)));
    await ix.refresh();
    expect(ix.summary().claude.today.output).toBe(3);

    // Same size, new mtime: read again.
    await utimes(p, new Date(NOW), new Date(NOW + 5000));
    await ix.refresh();
    expect(ix.lastRead).toEqual([p]);
  });

  test("cache: persists across restarts, and a broken cache file costs one full read", async () => {
    await claudeFile("a.jsonl", claudeMsg("m1", 1, usage(50)));
    const cachePath = join(dir, ".comb", "cache", "usage.json");
    const first = index(cachePath);
    await first.refresh();

    const second = index(cachePath);
    await second.refresh();
    expect(second.lastRead).toEqual([]);
    expect(second.summary().claude.today.output).toBe(50);

    await writeFile(cachePath, "{ broken");
    const third = index(cachePath);
    await third.refresh();
    expect(third.lastRead).toHaveLength(1);
    expect(third.summary().claude.today.output).toBe(50);
  });

  test("a deleted file drops out", async () => {
    const p = await claudeFile("a.jsonl", claudeMsg("m1", 1, usage(50)));
    const ix = index();
    await ix.refresh();
    await rm(p);
    await ix.refresh();
    expect(ix.summary().claude.today.output).toBe(0);
  });

  test("no local data: absent harnesses are missing, Cursor says it keeps none, an old Gemini says when", async () => {
    let ix = index();
    await ix.refresh();
    expect(ix.summary().harnesses.map((h) => [h.id, h.status])).toEqual([["claude", "missing"], ["codex", "missing"], ["gemini", "missing"], ["cursor", "missing"]]);
    expect(usageHtml({ ...ix.summary(), error: null })).toContain("Claude Code keeps no transcripts on this machine yet.");

    await mkdir(roots.cursor[0]!, { recursive: true });
    const chats = join(roots.gemini, "proj", "chats");
    await mkdir(chats, { recursive: true });
    await writeFile(join(chats, "old.json"), JSON.stringify({ sessionId: "g", messages: [{ id: "1", timestamp: at(24 * 90), model: "gemini-x", tokens: { input: 5, output: 5 } }] }));
    await writeFile(join(chats, "torn.json"), "{ half a file");
    await utimes(join(chats, "old.json"), new Date(NOW - 90 * 86400_000), new Date(NOW - 90 * 86400_000));
    ix = index();
    await ix.refresh();
    const s = ix.summary();
    const gemini = s.harnesses.find((h) => h.id === "gemini")!;
    expect(gemini).toMatchObject({ status: "ok", output: 0, lastAt: at(24 * 90), note: "1 unreadable line skipped." });
    expect(s.harnesses.find((h) => h.id === "cursor")).toMatchObject({ status: "none", note: "Installed, but keeps no token counts on this machine." });
    const html = usageHtml({ ...s, error: null });
    expect(html).toContain("Installed, but keeps no token counts on this machine.");
    expect(html).toContain("No use in 30 days. Last used");
  });

  test("Codex sessions count beside Claude Code, unpriced", async () => {
    const d = join(roots.codex, "2026", "11", "17");
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "rollout.jsonl"), line({ type: "session_meta", payload: { id: "c1" } }) + codexCount(1, 100, 0, 40) + codexCount(1, 100, 0, 40) + '{"type":"token_count", torn\n');
    const ix = index();
    await ix.refresh();
    const codex = ix.summary().harnesses.find((h) => h.id === "codex")!;
    expect(codex).toMatchObject({ status: "ok", output: 40, sessions: 1, note: "1 unreadable line skipped." });
  });
});

describe("GET /api/usage", () => {
  test("serves the summary from the given roots and persists the cache under the comb home", async () => {
    await mkdir(join(roots.claude, "-proj"), { recursive: true });
    await writeFile(join(roots.claude, "-proj", "a.jsonl"), claudeMsg("m1", 0, usage(42)));
    const home = join(dir, ".comb");
    const port = 49000 + Math.floor(Math.random() * 900);
    const page = startPage({
      port, home, claudeBin: "/bin/false", run: async () => ({ code: 1, stdout: "", stderr: "" }), pollMs: 60_000,
      hive: { close: async () => {} } as unknown as HiveClient, rexBin: null, hiveBin: null,
      hiveSetup: { enabled: false, mode: "off", bin: "hive", home: "/nonexistent-hive", why: "test" },
      usageRoots: roots,
      claudeSettingsPath: join(dir, "settings.json"),
    });
    await writeFile(join(dir, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "comb statusline" } }));
    await mkdir(join(home, "cache"), { recursive: true });
    await writeFile(join(home, "cache", "rate-limits.json"), JSON.stringify({
      at: new Date().toISOString(),
      rate_limits: { five_hour: { used_percentage: 47, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
    }));
    try {
      const res = await fetch(`${page.url}/api/usage`);
      const body = await res.json() as UsageSummary & { limits: Limits };
      expect(body.ready).toBe(true);
      expect(body.limits).toMatchObject({ status: "ok", windows: [{ id: "five_hour", usedPercent: 47, reset: false }] });
      expect(body.harnesses[0]).toMatchObject({ id: "claude", status: "ok", output: 42 });
      expect(existsSync(join(home, "cache", "usage.json"))).toBe(true);
      expect((await fetch(`${page.url}/api/usage`, { headers: { host: "evil.example" } })).status).toBe(403);
    } finally {
      await page.stop();
    }
  });
});

describe("panel formatting", () => {
  test("numbers compact past 10,000; model ids read as names; families keep their own color", () => {
    expect([compact(9_999), compact(12_900), compact(1_754_950), compact(4_720_119_353), compact(350_323)]).toEqual(["9,999", "12.9K", "1.75M", "4.72B", "350K"]);
    expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelName("claude-fable-5")).toBe("Fable 5");
    expect([familyOf("claude-sonnet-5-5"), familyOf("claude-haiku-5-5"), familyOf("claude-fable-5-2")]).toEqual(["sonnet", "other", "fable"]);
  });

  test("before the first read finishes, the panel says it is reading", () => {
    expect(usageHtml({ ready: false, error: null })).toContain("Reading transcripts");
    expect(usageHtml({ ready: false, error: "EACCES" })).toContain("Could not read usage: EACCES");
  });
});
