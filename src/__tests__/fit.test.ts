import { describe, expect, test } from "bun:test";

import { fitCount } from "../page/ui/fit";

describe("fitCount: how many PR badges the top bar shows before +N", () => {
  const w = [80, 90, 70, 100];
  const all = 80 + 90 + 70 + 100 + 3 * 6; // 358

  test("everything fits: no +N, even when +N itself would not have fit", () => {
    expect(fitCount(w, all, 50, 6)).toBe(4);
    expect(fitCount(w, 1000, 50, 6)).toBe(4);
  });

  test("one pixel short: room is kept for +N after the last badge shown", () => {
    // +N (50) then 80 (+6) then 90 (+6) = 232; adding 70 (+6) = 308 > 357.
    expect(fitCount(w, all - 1, 50, 6)).toBe(3);
    expect(fitCount(w, 232, 50, 6)).toBe(2);
    expect(fitCount(w, 231, 50, 6)).toBe(1);
  });

  test("order holds: a narrow badge later never jumps ahead of a wide one", () => {
    expect(fitCount([200, 20, 20], 150, 30, 6)).toBe(0);
  });

  test("no room at all, or no badges", () => {
    expect(fitCount(w, 0, 50, 6)).toBe(0);
    expect(fitCount([], 0, 50, 6)).toBe(0);
  });
});
