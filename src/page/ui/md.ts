/**
 * A small, safe Markdown renderer for agent prose: headings, lists, code,
 * quotes, tables, emphasis, links. Everything is escaped first; only http(s)
 * links survive.
 */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(s: string): string {
  const codes: string[] = [];
  let out = esc(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  out = out
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

export function md(src: string): string {
  const lines = src.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let i = 0;
  const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }

    const fence = line.match(/^\s*```/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    const head = line.match(/^(#{1,6})\s+(.*)$/);
    if (head) {
      const n = Math.min(head[1]!.length, 4);
      out.push(`<h${n}>${inline(head[2]!)}</h${n}>`);
      i++;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      const header = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      out.push(
        `<table><thead><tr>${header.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
        rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
        `</tbody></table>`,
      );
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${md(body.join("\n"))}</blockquote>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+/;
    const num = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || num.test(line)) {
      const ordered = num.test(line);
      const re = ordered ? num : bullet;
      const items: string[] = [];
      while (i < lines.length && (re.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && items.length))) {
        const l = lines[i++]!;
        if (re.test(l)) items.push(l.replace(re, ""));
        else items[items.length - 1] += " " + l.trim();
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${tag}>`);
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length && lines[i]!.trim() &&
      !/^(#{1,6}\s|\s*```|\s*>|\s*[-*+]\s+|\s*\d+[.)]\s+|\s*(-{3,}|\*{3,}|_{3,})\s*$)/.test(lines[i]!) &&
      !(lines[i]!.includes("|") && isTableSep(lines[i + 1] ?? ""))
    ) para.push(lines[i++]!);
    if (para.length === 0) { out.push(`<p>${inline(lines[i++]!)}</p>`); continue; }
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
  }
  return out.join("");
}
