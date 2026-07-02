// methodology.md → Narrator — the "play narration from here" speaker buttons on
// labeled section dividers and on article headings: each seeks the narration to
// the first spoken segment covering content at or below its host and plays.

import type { Narrator } from "../narrator.ts";
import { firstMarkAfter } from "../narratorDom.ts";
import { asMs } from "../../shared/time.ts";
import type { ManifestMark } from "../../shared/manifestSchema.ts";

// Speaker-with-waves glyph, drawn in `currentColor` so it inherits whatever
// muted tone its host (a labeled divider or a heading) carries and the hover
// rule can brighten it. Shared by the two "play narration from here" buttons —
// the divider speaker (`.divider-speaker`) and the heading speaker
// (`.heading-speaker`) — so the icon can't drift between them. The intrinsic
// 14px size suits the divider; heading CSS overrides it to an em size so it
// scales with the heading it sits beside.
const SPEAKER_GLYPH_SVG =
  '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M8 2.2 4.3 5.3H1.6v5.4h2.7L8 13.8z" fill="currentColor"/>' +
  '<path d="M10.6 5.4a3.3 3.3 0 0 1 0 5.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
  '<path d="M12.4 3.4a5.8 5.8 0 0 1 0 9.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
  "</svg>";

export class Speakers {
  constructor(private readonly sys: Narrator) {}

  // A labeled section divider (`.section-divider-labeled`) acts as a prose
  // chapter boundary that, by convention, mirrors a narration part — its text
  // is the same string as the part's chapter-strip pill. Progressively enhance
  // each one with a speaker button that jumps the narration to the first spoken
  // segment about content *below* the divider. Because narration is non-linear
  // (a segment can reference an earlier or later section than where it sits),
  // "first" is defined off the highlighted element's DOM position, not the
  // chapter the segment belongs to: the earliest mark, in narration time, whose
  // highlighted element follows the divider in document order. A divider with no
  // following narration (e.g. a trailing one) gets no button.
  setupDividerSpeakers() {
    if (!this.sys.manifest) return;
    const dividers = this.sys.narrationRoot.querySelectorAll<HTMLElement>(
      ".section-divider-labeled",
    );
    for (const divider of dividers) {
      if (divider.querySelector(".divider-speaker")) continue; // idempotent
      if (!this.firstMarkAfter(divider)) continue; // no narration below → no button
      const label = (divider.textContent ?? "").trim();
      // The divider is a presentational labeled `<div>` — the prose face of a
      // narration part, deliberately NOT a heading (the prose outline must not
      // depend on whether a post has narration; see methodology) and NOT a
      // `role="separator"` (a widget role can't host a control). A plain `<div>`
      // isn't a widget role, so it validly hosts this button; the button's own
      // aria-label ("Play narration from …") carries the part name to AT.
      divider.appendChild(this.buildSpeakerButton("divider-speaker", divider, label));
    }
  }

  // The article's headings (`<h2>`/`<h3>`/`<h4>`, matching headerLinks.ts) get
  // the same "play narration from here" affordance the labeled dividers carry —
  // a speaker button to the heading's right that seeks to the first narration
  // covering content at or below the heading, then plays. Headings aren't
  // guaranteed to be a narration entry point (only part dividers anchor a mark
  // by convention), but `firstMarkAfter` is defined for any element, so a
  // heading with no `<mark>` of its own simply routes to the first spoken
  // segment that follows it in document order. A heading with nothing narrated
  // below it (e.g. a trailing one) gets no button. Mirrors setupDividerSpeakers.
  setupHeadingSpeakers() {
    if (!this.sys.manifest) return;
    const headings = this.sys.narrationRoot.querySelectorAll<HTMLElement>(
      "h2, h3, h4",
    );
    for (const heading of headings) {
      if (heading.querySelector(".heading-speaker")) continue; // idempotent
      if (!this.firstMarkAfter(heading)) continue; // no narration below → no button
      const label = (heading.textContent ?? "").trim();
      heading.appendChild(this.buildSpeakerButton("heading-speaker", heading, label));
    }
  }

  // Build a "play narration from here" speaker button anchored to `target`.
  // Both the divider and heading speakers share this so the glyph, labelling,
  // and seek behaviour can't drift between them. `firstMarkAfter` is recomputed
  // on every click (not cached at setup) so the target stays correct if the
  // article DOM changes after enhancement — e.g. a figure enhancing
  // asynchronously, shifting which mark element is "first below".
  private buildSpeakerButton(
    className: string,
    target: Element,
    label: string,
  ): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.title = "Play narration from here";
    btn.setAttribute(
      "aria-label",
      label ? `Play narration from "${label}"` : "Play narration from here",
    );
    btn.innerHTML = SPEAKER_GLYPH_SVG;
    btn.addEventListener("click", () => {
      const m = this.firstMarkAfter(target);
      if (!m) return;
      // Nudge past the mark time, matching the chapter-jump offset, so a mark
      // sitting exactly on a chapter boundary still lands inside the new chapter
      // for the chapter plugin's `t >= startTime` range check.
      this.sys.seekToMs(asMs(m.time + 10));
      this.sys.player?.play();
    });
    return btn;
  }

  // Thin wrapper around the pure helper in ./narratorDom.ts — keeps the
  // `this.firstMarkAfter(el)` call sites (dividers and headings) readable.
  private firstMarkAfter(el: Element): ManifestMark | null {
    if (!this.sys.manifest) return null;
    return firstMarkAfter(el, this.sys.manifest.marks, this.sys.narrationRoot);
  }
}
