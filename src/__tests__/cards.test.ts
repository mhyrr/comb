import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentPreamble } from "../agents";
import { addItem, parseItem } from "../queue";
import { consequences, isTyping, keyIntent, stepCard } from "../page/ui/cards";

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
