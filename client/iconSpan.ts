// Wrap an inline SVG (imported as text) in an aria-hidden <span class>, with the
// SVG itself marked decorative + non-focusable. Shared by the byline-slot
// controls that render Font Awesome glyphs (copyMarkdown, subscribe, viewSource).
export function iconSpan(cls: string, svg: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = svg;
  const el = s.querySelector("svg");
  if (el) {
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("focusable", "false");
  }
  return s;
}
