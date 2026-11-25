import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentPreamble } from "../agents";
import { addItem, CHANGES_REQUIRED, parseItem } from "../queue";
import { cardLead, consequences, isTyping, keyIntent, stepCard } from "../page/ui/cards";

const who = (n: string) => (n === "maya" ? "Maya" : n);
const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods });

describe("what each answer does", () => {
  test("Go is the filer's action; Not now and Redirect are the filer's words, else comb's default lines", () => {
    expect(consequences({ from: "maya", action: "Start acme-api-tk51 on Sonnet.", onNo: null, onRedirect: null }, who)).toEqual([
      { label: "Go", text: "Start acme-api-tk51 on Sonnet.", filer: true },
      { label: "Not now", text: "Nothing happens. Maya hears your reason.", filer: false },
      { label: "Redirect", text: "Maya gets your instruction and works from it.", filer: false },
    ]);
    const own = consequences({ from: "docs-search", action: "Mark TK-12 done.", onNo: "The branch stays open; I stop here.", onRedirect: "Say which page to index and I add it." }, who);
    expect(own.map((c) => [c.text, c.filer])).toEqual([["Mark TK-12 done.", true], ["The branch stays open; I stop here.", true], ["Say which page to index and I add it.", true]]);
  });
});

describe("the queue's keys", () => {
  test("J/K move, G/N/R focus a button; no key means send", () => {
    expect(["j", "J", "k", "K", "g", "n", "r", "R"].map((k) => keyIntent(key(k), false))).toEqual([
      { move: 1 }, { move: 1 }, { move: -1 }, { move: -1 }, { focus: "go" }, { focus: "no" }, { focus: "redirect" }, { focus: "redirect" },
    ]);
    // Enter and Space are the browser's own button presses; the queue never handles them itself.
    for (const k of ["Enter", " ", "y", "Escape", "ArrowDown"]) expect(keyIntent(key(k), false)).toBeNull();
  });

  test("off while typing in a field, and with a modifier held (⌘K, ctrl-R stay the browser's)", () => {
    expect(keyIntent(key("g"), true)).toBeNull();
    expect(keyIntent(key("k", { metaKey: true }), false)).toBeNull();
    expect(keyIntent(key("r", { ctrlKey: true }), false)).toBeNull();
    expect(keyIntent(key("n", { altKey: true }), false)).toBeNull();
  });

  test("what counts as typing: text fields, textareas, selects, editable content; not buttons or checkboxes", () => {
    expect([
      isTyping({ tagName: "TEXTAREA" }), isTyping({ tagName: "INPUT", type: "text" }), isTyping({ tagName: "INPUT", type: "search" }),
      isTyping({ tagName: "INPUT" }), isTyping({ tagName: "SELECT" }), isTyping({ tagName: "DIV", isContentEditable: true }),
    ]).toEqual([true, true, true, true, true, true]);
    expect([isTyping({ tagName: "BUTTON" }), isTyping({ tagName: "INPUT", type: "checkbox" }), isTyping({ tagName: "ARTICLE" }), isTyping(null)])
      .toEqual([false, false, false, false]);
  });

  test("the current card steps and stays at the ends; one that left the queue falls back to the first", () => {
    const ids = ["a", "b", "c"];
    expect([stepCard(ids, "a", 1), stepCard(ids, "c", 1), stepCard(ids, "a", -1), stepCard(ids, "b", -1)]).toEqual(["b", "c", "a", "a"]);
    expect([stepCard(ids, null, 0), stepCard(ids, "gone", 1), stepCard(ids, "b", 0), stepCard([], "a", 1)]).toEqual(["a", "a", "b", null]);
  });
});

describe("on_no and on_redirect in the queue", () => {
  let home: string;
  beforeAll(async () => { home = await mkdtemp(join(tmpdir(), "comb-cards-")); });
  afterAll(async () => { await rm(home, { recursive: true, force: true }); });

  test("they round-trip in item.md, one line each; an older item without them reads as null", async () => {
    const item = await addItem({
      kind: "review", from: "docs-search", title: "Review: docs search", action: "Mark TK-12 done.",
      onNo: "The branch stays open;\nI stop here.", onRedirect: "Say which page to index.",
    }, home, new Date("2026-11-20T10:00:00Z"));
    const text = await readFile(join(home, "queue", item.id, "item.md"), "utf-8");
    expect(text).toContain("onNo: The branch stays open; I stop here.\n");
    expect(text).toContain("onRedirect: Say which page to index.\n");
    expect(parseItem(text)).toEqual(item);
    expect(parseItem("---\nid: old\nkind: proposal\ntitle: t\naction: a\n---\n")).toMatchObject({ onNo: null, onRedirect: null });
    const bare = await addItem({ kind: "decision", from: "maya", title: "Store", action: "Ship the store you pick.", onNo: "  " }, home);
    expect([bare.onNo, bare.onRedirect]).toEqual([null, null]);
  });

  test("the core contract tells agents when to fill them", () => {
    const text = agentPreamble({ name: "x", dir: "/tmp/x", parent: "maya" });
    expect(text).toContain("`on_no`");
    expect(text).toContain("`on_redirect`");
  });
});

describe("what changes for you (D31)", () => {
  let home: string;
  beforeAll(async () => { home = await mkdtemp(join(tmpdir(), "comb-changes-")); });
  afterAll(async () => { await rm(home, { recursive: true, force: true }); });
  const proposal = { kind: "proposal", from: "maya", title: "Morning proposals", action: "Start comb-tk-012." };

  test("a proposal without changes is refused with what to write; the other kinds may leave it off", async () => {
    for (const changes of [undefined, null, "", "  \n "]) {
      await expect(addItem({ ...proposal, changes }, home)).rejects.toThrow(CHANGES_REQUIRED);
    }
    expect(CHANGES_REQUIRED).toContain("from his side of the screen");
    expect(CHANGES_REQUIRED).toContain("Not the implementation");
    const review = await addItem({ kind: "review", from: "x", title: "Review", action: "Mark it done." }, home);
    expect(review.changes).toBeNull();
  });

  test("it round-trips in item.md as one line; an item from before it reads as null", async () => {
    const item = await addItem({ ...proposal, changes: "The queue shows a 'What changes for you'\nline on every proposal." }, home);
    const text = await readFile(join(home, "queue", item.id, "item.md"), "utf-8");
    expect(text).toContain("changes: The queue shows a 'What changes for you' line on every proposal.\n");
    expect(parseItem(text)).toEqual(item);
    expect(parseItem("---\nid: old\nkind: proposal\ntitle: t\naction: a\n---\n").changes).toBeNull();
  });

  test("the card shows it first, above what each answer does; an older item shows only the answers", () => {
    const q = { from: "maya", action: "Start comb-tk-012.", onNo: null, onRedirect: null, changes: "Your <queue> shows a line." };
    const html = cardLead(q, who);
    expect(html.startsWith('<p class="qchanges"><b>What changes for you</b><span>Your &lt;queue&gt; shows a line.</span></p>')).toBe(true);
    expect(html.indexOf("What changes for you")).toBeLessThan(html.indexOf("<b>Go</b>"));
    const old = cardLead({ ...q, changes: null }, who);
    expect(old).not.toContain("What changes for you");
    expect(old.startsWith('<ul class="qout"')).toBe(true);
  });

  test("the core contract says how to write it, with one good example and one bad", () => {
    const text = agentPreamble({ name: "x", dir: "/tmp/x", parent: "maya" });
    expect(text).toContain("A proposal needs `changes`");
    expect(text).toContain(`Good: "The queue shows a 'What changes for you' line on every proposal."`);
    expect(text).toContain(`Bad: "Adds a changes field to QueueItem."`);
  });

  test("comb queue add refuses a proposal without --changes and files one with it", async () => {
    const run = (...args: string[]) => {
      const p = Bun.spawnSync(["bun", join(import.meta.dir, "..", "cli.ts"), "queue", "add", ...args], {
        env: { ...process.env, COMB_HOME: home, COMB_AGENT: "tester", COMB_HIVE: "off" },
      });
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    };
    const refused = run("--kind", "proposal", "--title", "CLI bet", "--action", "Do it.");
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("A proposal needs `changes`");
    const ok = run("--kind", "proposal", "--title", "CLI bet", "--action", "Do it.", "--changes", "You see a CLI card.", "--why", "Because.");
    expect(ok.code).toBe(0);
    const id = ok.out.match(/Filed (\S+)\./)?.[1];
    expect(id).toBeTruthy();
    const item = parseItem(await readFile(join(home, "queue", id!, "item.md"), "utf-8"));
    expect(item).toMatchObject({ kind: "proposal", from: "tester", changes: "You see a CLI card.", body: "Because." });
    expect(run("--kind", "proposal", "--bogus", "x").code).toBe(2);
  });
});
