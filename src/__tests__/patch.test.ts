import { expect, test } from "bun:test";

import { admit, stableHtml } from "../page/ui/patch";

test("a ticking time is not a change; anything else is", () => {
  const at = (text: string, title = "Waiting") =>
    `<h3>${title}</h3><time data-ago="2026-11-15T10:00:00Z" data-long="1" title="x">${text}</time>`;
  expect(stableHtml(at("4m ago"))).toBe(stableHtml(at("5m ago")));
  expect(stableHtml(at("4m ago"))).not.toBe(stableHtml(at("4m ago", "Waiting on you")));
  // Only the ticker's own <time data-ago> elements are exempt.
  expect(stableHtml("<time>4m</time>")).not.toBe(stableHtml("<time>5m</time>"));
});

test("while Greg is busy with the queue, new items wait and items on screen stay", () => {
  const shown = new Set(["a", "b"]);
  expect(admit(["new1", "a", "new2", "b"], shown, true)).toEqual({ show: ["a", "b"], waiting: ["new1", "new2"] });
  // An item that left (answered elsewhere) just drops out.
  expect(admit(["a"], shown, true)).toEqual({ show: ["a"], waiting: [] });
  // At a quiet moment everything shows, in queue order.
  expect(admit(["new1", "a", "new2", "b"], shown, false)).toEqual({ show: ["new1", "a", "new2", "b"], waiting: [] });
});
