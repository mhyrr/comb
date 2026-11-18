/**
 * The one hover card (pull-request badges, ticket hexes). A feature registers a
 * host selector and a renderer; this file owns the card, its placement and the
 * pointer, focus and scroll rules, so every card looks and behaves the same.
 */

type Host = {
  selector: string;
  /** The card's inner HTML for `el`, or null for no card. Call `update` later to replace it (a lazy summary). */
  render: (el: Element, update: (html: string) => void) => string | null;
  /** Touch has no hover; a tap there does what the host's click does, with no card. */
  skipTouch?: boolean;
};
const hosts: Host[] = [];
export const registerCard = (h: Host) => { hosts.push(h); };

let tipEl: HTMLElement | null = null;
let current: Element | null = null;

function place(from: Element, el: HTMLElement) {
  // Measure at the left edge: left where it was, near the right edge, it would shrink to fit.
  el.style.left = "0px";
  el.style.top = "0px";
  el.hidden = false;
  const at = from.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const below = at.bottom + 6;
  el.style.left = `${Math.max(8, Math.min(at.left, innerWidth - w - 8))}px`;
  el.style.top = `${below + h > innerHeight - 8 ? Math.max(8, at.top - h - 6) : below}px`;
}

function show(from: Element, host: Host) {
  const html = host.render(from, (next) => {
    if (current !== from || !tipEl || tipEl.hidden) return; // the card moved on
    tipEl.innerHTML = next;
    place(from, tipEl);
  });
  if (html === null) { hideCard(); return; }
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "pr-tip";
    tipEl.setAttribute("role", "tooltip");
    document.body.append(tipEl);
  }
  current = from;
  tipEl.innerHTML = html;
  place(from, tipEl);
}
export function hideCard() { current = null; if (tipEl) tipEl.hidden = true; }

function hostOf(t: EventTarget | null): { el: Element; host: Host } | null {
  if (!(t instanceof Element)) return null;
  for (const host of hosts) {
    const el = t.closest(host.selector);
    if (el) return { el, host };
  }
  return null;
}
const noHover = () => matchMedia("(hover: none)").matches;

document.addEventListener("mouseover", (e) => {
  const h = hostOf(e.target);
  if (!h) { if (current) hideCard(); return; } // also clears a card whose host a redraw removed
  if (h.host.skipTouch && noHover()) return;
  if (h.el !== current) show(h.el, h.host);
});
document.addEventListener("mouseout", (e) => {
  const h = hostOf(e.target);
  if (h && !h.el.contains(e.relatedTarget as Node | null)) hideCard();
});
document.addEventListener("focusin", (e) => { const h = hostOf(e.target); if (h) show(h.el, h.host); else hideCard(); });
document.addEventListener("focusout", (e) => { if (hostOf(e.target)) hideCard(); });
document.addEventListener("click", () => { if (current) hideCard(); }, true);
// A scroll that carries the host moves it from under the card; one elsewhere (a feed, a chat) must not shut it.
document.addEventListener("scroll", (e) => {
  const t = e.target;
  if (current && (t === document || (t instanceof Node && t.contains(current)))) hideCard();
}, true);
