/**
 * Arrow-key moves through a grid laid out row by row. No DOM, so the tests can
 * import it. Used by the ticket honeycomb: one tab stop per grid, arrows inside.
 */

/** The index a key moves to, or null when the key is not a move. Moves stop at the ends; up and down move one row (`cols` cells). */
export function nextCell(key: string, i: number, count: number, cols: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  const clamp = (n: number) => Math.max(0, Math.min(last, n));
  switch (key) {
    case "ArrowRight": return clamp(i + 1);
    case "ArrowLeft": return clamp(i - 1);
    case "ArrowDown": return i + cols > last ? i : i + cols; // no row below: stay, rather than jump to the end
    case "ArrowUp": return i - cols < 0 ? i : i - cols;
    case "Home": return 0;
    case "End": return last;
    default: return null;
  }
}
