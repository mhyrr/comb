import { describe, expect, test } from "bun:test";
import { parseTicketText, stripMarkdown, ticketSummary } from "../page/ui/ticket-text";

describe("stripMarkdown", () => {
  test("removes emphasis, code ticks, links, images and html", () => {
    expect(stripMarkdown("Use **bold**, _soft_, `src/queue.ts` and [a link](https://x.io) ![shot](a.png) <b>now</b>."))
      .toBe("Use bold, soft, src/queue.ts and a link shot now.");
  });
  test("drops headings, code fences, tables and rules; unwraps lists and quotes", () => {
    const md = "## Done when\n\n```ts\nconst x = 1;\n```\n| a | b |\n|---|---|\n---\n- [ ] first item\n1. second item\n> quoted";
    expect(stripMarkdown(md)).toBe("first item second item quoted");
  });
  test("an unclosed code fence drops the rest", () => {
    expect(stripMarkdown("Real text.\n```\ncode forever")).toBe("Real text.");
  });
});

describe("ticketSummary", () => {
  test("takes two short sentences", () => {
    expect(ticketSummary("First one. Second one. Third one.")).toBe("First one. Second one.");
  });
  test("takes one sentence when two do not fit", () => {
    const long = `${"a".repeat(120)}. B${"b".repeat(120)}.`;
    expect(ticketSummary(long)).toBe(`${"a".repeat(120)}.`);
  });
  test("ellipsizes a long sentence at a word boundary within the limit", () => {
    const out = ticketSummary(Array.from({ length: 80 }, (_, i) => `word${i}`).join(" "));
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, -1).split(" ").every((w) => /^word\d+$/.test(w))).toBe(true); // no word cut in half
  });
  test("an empty or markup-only body gives an empty summary", () => {
    expect(ticketSummary("")).toBe("");
    expect(ticketSummary("```\ncode\n```\n## Heading")).toBe("");
  });
});

describe("parseTicketText", () => {
  test("reads title, fields and the body after ---", () => {
    const t = parseTicketText("# TK-001: Send precedents\n**Status:** open\n**Updated:** 2026-11-12T16:43:35Z\n\n---\n\nBody **here**.");
    expect(t.title).toBe("Send precedents");
    expect(t.fields.get("updated")).toBe("2026-11-12T16:43:35Z");
    expect(ticketSummary(t.body)).toBe("Body here.");
  });
});
