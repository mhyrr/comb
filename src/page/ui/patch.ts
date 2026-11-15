/**
 * Updating the page without moving what the reader is using (D26).
 *
 * Three rules. A re-render never destroys a focused field or its text: the
 * live node is carried into the new markup. Lists are patched by key, so only
 * changed rows are touched. And the row the reader is looking at keeps its
 * screen position when rows above it come or go.
 */

/**
 * The markup with each `<time data-ago>`'s text taken out. The 15-second
 * ticker keeps those texts current, so "4m ago" becoming "5m ago" is not a
 * change worth a re-render.
 */
export function stableHtml(html: string): string {
  return html.replace(/(<time data-ago[^>]*>)[^<]*(<\/time>)/g, "$1$2");
}

/**
 * Which open items show now and which wait behind the "N new" pill. While the
 * reader is busy with the queue, items not already on screen wait; otherwise
 * everything shows. Order follows `openIds`.
 */
export function admit(openIds: string[], shown: ReadonlySet<string>, holding: boolean): { show: string[]; waiting: string[] } {
  if (!holding) return { show: openIds, waiting: [] };
  return { show: openIds.filter((id) => shown.has(id)), waiting: openIds.filter((id) => !shown.has(id)) };
}

function fromHtml(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

type Field = HTMLInputElement | HTMLTextAreaElement;
const isField = (el: Element | null): el is Field => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;

/**
 * Runs `swap`, which replaces markup inside `root`, without losing the
 * focused element. A focused field with `data-keep` is carried over as the
 * same node (its value, caret and undo history with it); any other focused
 * element with `data-keep` gets focus back on its counterpart.
 */
export function keepingFocus(root: Element, swap: () => void): void {
  const active = document.activeElement;
  const key = active instanceof HTMLElement && root.contains(active) ? active.dataset.keep : undefined;
  if (!key) { swap(); return; }
  const field = isField(active) ? active : null;
  const sel = field && field.selectionStart !== null ? [field.selectionStart, field.selectionEnd ?? field.selectionStart, field.selectionDirection ?? "none"] as const : null;
  const scroll = field?.scrollTop ?? 0;
  swap();
  const twin = root.querySelector<HTMLElement>(`[data-keep="${CSS.escape(key)}"]`);
  if (!twin) return;
  if (field) {
    if (twin !== field) twin.replaceWith(field);
    field.focus({ preventScroll: true });
    if (sel) field.setSelectionRange(sel[0], sel[1], sel[2]);
    field.scrollTop = scroll;
  } else {
    twin.focus({ preventScroll: true });
  }
}

/** Replaces `el`'s contents when the markup changed (time texts aside), keeping focus. */
export function setHtml(el: HTMLElement, html: string): void {
  const stable = stableHtml(html);
  if (el.dataset.html === stable) return;
  el.dataset.html = stable;
  keepingFocus(el, () => { el.innerHTML = html; });
}

/**
 * Makes `container`'s children match `items`, by `data-key`: a new key is
 * inserted, a gone key removed, a changed one replaced (keeping focus), and an
 * unchanged one left alone.
 */
export function patchList(container: HTMLElement, items: { key: string; html: string }[]): void {
  const existing = new Map<string, HTMLElement>();
  for (const c of Array.from(container.children) as HTMLElement[]) {
    if (c.dataset.key) existing.set(c.dataset.key, c);
    else c.remove();
  }
  let prev: Element | null = null;
  for (const it of items) {
    const stable = stableHtml(it.html);
    let el = existing.get(it.key);
    existing.delete(it.key);
    if (el && el.dataset.html !== stable) {
      const old: HTMLElement = el;
      const next = fromHtml(it.html);
      next.dataset.key = it.key;
      next.dataset.html = stable;
      // Build the new row in place of the old, carrying a focused field across.
      keepingFocus(container, () => { old.replaceWith(next); });
      el = next;
    } else if (!el) {
      el = fromHtml(it.html);
      el.dataset.key = it.key;
      el.dataset.html = stable;
    }
    const want: Element | null = prev ? prev.nextElementSibling : container.firstElementChild;
    if (want !== el) keepingFocus(container, () => { container.insertBefore(el!, want); });
    prev = el;
  }
  for (const el of existing.values()) el.remove();
}

/**
 * Runs `change` and then scrolls `scroller` so the first visible element of
 * `candidates()` sits where it sat before. If that element is gone (the
 * reader answered it), the next one that was visible holds still instead.
 */
export function holdingPlace(scroller: HTMLElement | null, candidates: () => HTMLElement[], change: () => void): void {
  if (!scroller || scroller.scrollTop === 0) { change(); return; }
  const top = scroller.getBoundingClientRect().top;
  const bottom = top + scroller.clientHeight;
  const seen = candidates()
    .map((el) => ({ el, at: el.getBoundingClientRect() }))
    .filter(({ at }) => at.bottom > top && at.top < bottom)
    .slice(0, 4)
    .map(({ el, at }) => ({ el, before: at.top }));
  change();
  const anchor = seen.find((s) => s.el.isConnected);
  if (!anchor) return;
  const delta = anchor.el.getBoundingClientRect().top - anchor.before;
  if (Math.abs(delta) >= 1) scroller.scrollTop += delta;
}
