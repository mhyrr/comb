/**
 * How many badges fit in a row of `avail` pixels, keeping their order. When
 * not all fit, room is kept for the "+N" button (`moreW` wide) after the last
 * one shown. `gap` is the space between neighbours. No DOM, so it is tested.
 */
export function fitCount(widths: number[], avail: number, moreW: number, gap: number): number {
  const total = widths.reduce((s, w) => s + w, 0) + gap * Math.max(0, widths.length - 1);
  if (total <= avail) return widths.length;
  let used = moreW;
  let n = 0;
  for (const w of widths) {
    if (used + gap + w > avail) break;
    used += gap + w;
    n++;
  }
  return n;
}
