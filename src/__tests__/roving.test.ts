import { describe, expect, test } from "bun:test";
import { nextCell } from "../page/ui/roving";

describe("nextCell", () => {
  // 10 cells, 4 per row: rows are 0-3, 4-7, 8-9.
  test("left and right step through the order and stop at the ends", () => {
    expect(nextCell("ArrowRight", 3, 10, 4)).toBe(4);
    expect(nextCell("ArrowLeft", 4, 10, 4)).toBe(3);
    expect(nextCell("ArrowRight", 9, 10, 4)).toBe(9);
    expect(nextCell("ArrowLeft", 0, 10, 4)).toBe(0);
  });
  test("up and down move one row and stay put when there is no row there", () => {
    expect(nextCell("ArrowDown", 1, 10, 4)).toBe(5);
    expect(nextCell("ArrowUp", 5, 10, 4)).toBe(1);
    expect(nextCell("ArrowDown", 7, 10, 4)).toBe(7); // 11 does not exist
    expect(nextCell("ArrowUp", 2, 10, 4)).toBe(2);
  });
  test("Home and End jump to the first and last cell", () => {
    expect(nextCell("Home", 6, 10, 4)).toBe(0);
    expect(nextCell("End", 6, 10, 4)).toBe(9);
  });
  test("other keys, and an empty grid, are not moves", () => {
    expect(nextCell("Enter", 2, 10, 4)).toBeNull();
    expect(nextCell("a", 2, 10, 4)).toBeNull();
    expect(nextCell("ArrowRight", 0, 0, 4)).toBeNull();
  });
});
