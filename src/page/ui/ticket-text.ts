/**
 * Plain-text pieces of hive's show_ticket text, for the ticket hover card.
 * No DOM here, so the tests can import it.
 */

/** show_ticket text: a "# ID: title" line, bold "**Key:** value" lines, then the body after "---". */
export function parseTicketText(text: string): { title: string; fields: Map<string, string>; body: string } {
  const lines = text.split("\n");
  const title = (lines.find((l) => l.startsWith("# ")) ?? "").replace(/^#\s+[^:]+:\s*/, "");
  const fields = new Map<string, string>();
  for (const l of lines) {
    const m = l.match(/^\*\*([^*]+):\*\*\s*(.*)$/);
    if (m) fields.set(m[1]!.toLowerCase(), m[2]!);
  }
  const cut = text.indexOf("\n---");
  return { title, fields, body: cut >= 0 ? text.slice(cut + 4) : "" };
}

/** Markdown to one line of plain text: no code blocks, tables, headings, list marks, links or emphasis. */
export function stripMarkdown(src: string): string {
  const kept = src
    .replace(/\r/g, "")
    .replace(/```[\s\S]*?(```|$)/g, "\n")
    .split("\n")
    .filter((l) => !/^\s{0,3}#{1,6}\s/.test(l) && !/^\s*\|/.test(l) && !/^\s*([-*_]\s*){3,}$/.test(l) && !/^\s*(-{3,}|={3,})\s*$/.test(l))
    .map((l) => l.replace(/^\s*(>\s*)+/, "").replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, ""));
  return kept.join(" ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first sentence or two of a ticket body, as plain text of about `max` characters, ellipsized. */
export function ticketSummary(body: string, max = 200): string {
  const plain = stripMarkdown(body);
  if (!plain) return "";
  const sentences = plain.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/);
  let out = sentences[0]!;
  if (sentences[1] && out.length + 1 + sentences[1].length <= max) out += ` ${sentences[1]}`;
  if (out.length <= max) return out;
  const cut = out.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "")}…`;
}
