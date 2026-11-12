/**
 * Follows one transcript as it grows. The first read returns the recent past;
 * each later read returns only what was appended.
 */
import { open, stat } from "node:fs/promises";

import { parseLines, settle, type FeedEvent } from "../transcript";

const HISTORY_BYTES = 768 * 1024;
const HISTORY_EVENTS = 400;
const HISTORY_MIN = 60;
const HISTORY_MAX_BYTES = 48 * 1024 * 1024;

export class Tail {
  /** Byte offset just past the last whole line read. */
  private offset = 0;

  constructor(readonly path: string, private readonly defaultFrom: string, private readonly cwd: string) {}

  /** The recent past, settled: each tool call already carries its result. */
  async history(): Promise<FeedEvent[]> {
    const size = await fileSize(this.path);
    if (size === null) return [];
    // Screenshots make some lines huge; read further back until there is
    // enough history to show.
    for (let bytes = HISTORY_BYTES; ; bytes *= 4) {
      const start = Math.max(0, size - bytes);
      const { text, end } = await readWholeLines(this.path, start, size);
      this.offset = end;
      const lines = text.split("\n");
      if (start > 0) lines.shift(); // cut mid-line
      const events = settle(parseLines(lines, this.defaultFrom, this.cwd)).filter((e) => e.k !== "done");
      if (events.length >= HISTORY_MIN || start === 0 || bytes >= HISTORY_MAX_BYTES) return events.slice(-HISTORY_EVENTS);
    }
  }

  /** What was appended since the last read. "done" events refer back to earlier tool calls. */
  async next(): Promise<FeedEvent[]> {
    const size = await fileSize(this.path);
    if (size === null || size === this.offset) return [];
    if (size < this.offset) this.offset = 0; // rewritten from scratch
    const { text, end } = await readWholeLines(this.path, this.offset, size);
    this.offset = end;
    return parseLines(text.split("\n"), this.defaultFrom, this.cwd);
  }
}

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null; // intentional: no transcript yet
  }
}

/**
 * Reads [start, size) up to the last newline, so a line still being written
 * (or a UTF-8 character cut in half) waits for the next read.
 */
async function readWholeLines(path: string, start: number, size: number): Promise<{ text: string; end: number }> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const last = buf.lastIndexOf(0x0a);
    if (last < 0) return { text: "", end: start };
    return { text: buf.subarray(0, last).toString("utf-8"), end: start + last + 1 };
  } finally {
    await fh.close();
  }
}
