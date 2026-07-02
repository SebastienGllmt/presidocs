// methodology.md → Chapter strip — the single-row chapter strip: one pill per
// top-level chapter (sub-chapters as slash-separated segments), the
// hold-to-scroll arrows, edge fades, wheel→horizontal translation, and the
// active-pill tracking that rides the audio clock.

import type { Narrator } from "../narrator.ts";
import { secondsToMs, asSeconds } from "../../shared/time.ts";
import type { Manifest, ManifestChapter } from "../../shared/manifestSchema.ts";

export class ChapterStrip {
  constructor(private readonly sys: Narrator) {}

  // Active-highlight target per chapter id. For a top-level chapter this is the
  // pill (or its parent-segment inside a segmented pill); for a sub-chapter
  // either its own segment or — in the 1-child collapsed case — the parent's
  // flat pill, so the strip still lights up as audio crosses into the sub.
  private pillEls = new Map<string, HTMLElement>();
  // Last chapter we auto-scrolled the strip to. `updateActiveChapter` runs
  // every rAF tick, so we only scroll the active pill into view when the
  // active chapter actually changes — not on every frame.
  private lastActiveChapterId: string | null = null;
  // Chapter strip's hold-to-scroll arrows (desktop only) + their flex wrapper,
  // and the rAF handle for an in-progress hold.
  private navEl: HTMLElement | null = null;
  private prevArrow: HTMLButtonElement | null = null;
  private nextArrow: HTMLButtonElement | null = null;
  private arrowRaf: number | null = null;

  // Renders the single-row chapter strip. With the two-level hierarchy we
  // render ONE pill per top-level chapter; its sub-chapters
  // become slash-separated SEGMENTS inside that pill, so the grouping travels
  // with the pill instead of relying on a separate side-label that gets lost
  // on scroll. The pill NUMBER (1-9 keyboard shortcut) labels the top-level
  // index, in lockstep with the keyboard map. Two collapse cases keep the
  // strip clean: a leaf top-level chapter renders as a flat numbered pill (the
  // single-level shape, byte-for-byte for a flat post); a part with exactly
  // one sub also renders as a flat pill — the sub is still reachable by
  // scrubbing, and its active-state highlight is routed to the parent pill so
  // the strip keeps showing "where am I" correctly.
  renderChapters(manifest: Manifest) {
    if (!this.sys.chapterContainer) return;
    this.sys.chapterContainer.innerHTML = "";
    this.pillEls.clear();

    // Walk the manifest once and group children under their top-level parent.
    // Manifest order is document order and the build enforces parent-before-
    // child, so a single forward pass suffices.
    type Group = { parent: ManifestChapter; children: ManifestChapter[] };
    const groups: Group[] = [];
    const groupById = new Map<string, Group>();
    for (const c of manifest.chapters) {
      if (c.parentId === undefined) {
        const g: Group = { parent: c, children: [] };
        groups.push(g);
        groupById.set(c.id, g);
        continue;
      }
      const g = groupById.get(c.parentId);
      if (g) g.children.push(c);
      else {
        // Defensive: a child whose parent we never saw. The build-time
        // normalizer should have already promoted this to top-level — render
        // it as its own pill rather than dropping it on the floor.
        const g2: Group = { parent: c, children: [] };
        groups.push(g2);
        groupById.set(c.id, g2);
      }
    }

    groups.forEach((group, i) => {
      const partIndex = i + 1; // top-level index — drives the 1-9 keyboard map
      const pill =
        group.children.length >= 2
          ? this.makeSegmentedPill(group, partIndex)
          : this.makeFlatPill(group, partIndex);
      this.sys.chapterContainer!.appendChild(pill);
    });

    this.lastActiveChapterId = null;
    this.updateChapterFades();
    this.updateActiveChapter();
  }

  // Numbered flat pill — used both for leaf top-level chapters and for the
  // 1-sub collapse case. The sub (if any) registers against the same DOM
  // element so its active-state highlight rides the parent pill.
  private makeFlatPill(
    group: { parent: ManifestChapter; children: ManifestChapter[] },
    partIndex: number,
  ): HTMLButtonElement {
    const { parent, children } = group;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chapter-pill";
    btn.dataset.chapterId = parent.id;
    btn.setAttribute("aria-label", `Jump to chapter ${partIndex}: ${parent.title}`);
    btn.innerHTML = `<span class="ch-num">${partIndex}</span><span class="ch-title"></span>`;
    btn.querySelector(".ch-title")!.textContent = parent.title;
    btn.addEventListener("click", () => this.sys.jumpToChapter(parent));
    this.pillEls.set(parent.id, btn);
    for (const child of children) this.pillEls.set(child.id, btn);
    return btn;
  }

  // Segmented pill — `[ N  «Part» Member A / Member B / … ]`. The part is opened
  // by its section-intro chapter (the parent): the spoken transition whose first
  // mark anchors the divider. Its title is the part name, rendered as the
  // emphasized `«Part»` group label; the member chapters render as the inert
  // segments. The pill is one `<button>` (a single keyboard Tab stop), and click
  // routing is strict containment: a jump fires only when the click lands on a
  // member segment or the group label — the slashes, the number badge, and the
  // padding around it are predictable no-ops. Strict containment beats routing a
  // dead-zone click to the nearest segment by distance, which would let a click
  // on a segment's tail jump to its neighbor.
  private makeSegmentedPill(
    group: { parent: ManifestChapter; children: ManifestChapter[] },
    partIndex: number,
  ): HTMLButtonElement {
    const { parent, children } = group;
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "chapter-pill segmented";
    pill.setAttribute(
      "aria-label",
      `Chapter ${partIndex}: ${[parent, ...children]
        .map((c) => c.title)
        .join(", ")}`,
    );

    const num = document.createElement("span");
    num.className = "ch-num";
    num.textContent = String(partIndex);
    pill.appendChild(num);

    // The group label IS the section-intro chapter (the parent): clicking it
    // plays that intro — the first thing in the part — and its active highlight
    // rides the label, so the strip lights up while the transition plays.
    const gl = document.createElement("span");
    gl.className = "ch-group";
    gl.textContent = parent.title;
    this.pillEls.set(parent.id, gl);
    pill.appendChild(gl);

    // Segment span → chapter, so the click handler can resolve which span was
    // hit without round-tripping through dataset attributes. Slash separators
    // sit *between* members only — the first member follows the group label
    // directly (the label's own spacing sets it apart).
    const byEl = new Map<HTMLSpanElement, ManifestChapter>();
    children.forEach((child, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "ch-sep";
        sep.setAttribute("aria-hidden", "true");
        sep.textContent = "/";
        pill.appendChild(sep);
      }
      const seg = document.createElement("span");
      seg.className = "ch-seg";
      seg.dataset.sub = "";
      seg.dataset.chapterId = child.id;
      seg.textContent = child.title;
      this.pillEls.set(child.id, seg);
      byEl.set(seg, child);
      pill.appendChild(seg);
    });

    pill.addEventListener("click", (e) => {
      // Keyboard activation (Enter/Space) has no pointer target — jump to the
      // part's intro, the sensible default for the one-Tab-stop pill.
      if (e.detail === 0) {
        this.sys.jumpToChapter(parent);
        return;
      }
      const target = e.target as HTMLElement | null;
      // The group label plays the section intro (the first thing in the part).
      if (target?.closest(".ch-group")) {
        this.sys.jumpToChapter(parent);
        return;
      }
      const segEl = target?.closest(".ch-seg") as HTMLSpanElement | null;
      const hit = segEl ? byEl.get(segEl) : null;
      if (hit) this.sys.jumpToChapter(hit);
      // No-op when the click missed every segment (slash, padding, badge).
    });

    return pill;
  }

  // Wraps the chapter strip in a flex row flanked by hold-to-scroll ‹ / ›
  // arrows, and wires the scroll/resize listeners that keep the edge fades and
  // arrow states current. Runs once (the strip element persists across
  // re-renders, so the wrapper and listeners must not be rebound per render).
  setupChapterStrip() {
    const strip = this.sys.chapterContainer;
    if (!strip) return;
    const parent = strip.parentElement;
    if (parent) {
      const nav = document.createElement("div");
      nav.className = "chapter-nav";
      parent.insertBefore(nav, strip);
      this.prevArrow = this.makeChapterArrow(-1, "Scroll to earlier chapters");
      this.nextArrow = this.makeChapterArrow(1, "Scroll to later chapters");
      // Moves `strip` out of `parent` and between the two arrows.
      nav.append(this.prevArrow, strip, this.nextArrow);
      this.navEl = nav;
    }
    // Recompute fades/arrow state as the strip scrolls (passive — read-only)
    // and whenever its width changes (orientation flip, dock resize).
    strip.addEventListener("scroll", () => this.updateChapterFades(), {
      passive: true,
    });
    new ResizeObserver(() => this.updateChapterFades()).observe(strip);
    // Translate vertical (and horizontal) wheel input into horizontal scroll.
    // Browsers don't reliably map a vertical wheel onto a horizontally-only
    // scrollable element (Firefox doesn't at all), so we do it ourselves —
    // but only when the strip can still scroll that way, otherwise we let the
    // event through so the page keeps scrolling at the edges.
    strip.addEventListener(
      "wheel",
      (e) => {
        const max = strip.scrollWidth - strip.clientWidth;
        if (max <= 0) return;
        const unit = e.deltaMode === 1 ? 16 : 1; // line vs. pixel mode
        const raw =
          Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        const delta = raw * unit;
        if (delta === 0) return;
        const atStart = strip.scrollLeft <= 0;
        const atEnd = strip.scrollLeft >= max;
        if ((delta < 0 && atStart) || (delta > 0 && atEnd)) return;
        e.preventDefault();
        strip.scrollLeft += delta;
      },
      { passive: false },
    );
    this.updateChapterFades();
  }

  // A press-and-hold scroll arrow. Holding scrolls the strip continuously via
  // rAF (mouse/touch through pointer events); a keyboard activation — which
  // fires `click` with `detail === 0` and no pointer sequence — nudges one
  // step. The arrow disables itself at the matching edge (see
  // updateChapterFades) and stops mid-hold if it reaches that edge.
  private makeChapterArrow(dir: 1 | -1, label: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `chapter-arrow chapter-arrow-${dir < 0 ? "prev" : "next"}`;
    btn.setAttribute("aria-label", label);
    // Decorative glyph; the aria-label carries the accessible name.
    btn.innerHTML = `<span aria-hidden="true">${dir < 0 ? "‹" : "›"}</span>`;
    const release = () => this.stopArrowScroll();
    btn.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault(); // don't steal focus / start a text selection
      btn.setPointerCapture(e.pointerId);
      this.startArrowScroll(dir);
    });
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
    btn.addEventListener("click", (e) => {
      if (e.detail === 0) this.nudgeChapterStrip(dir); // keyboard activation
    });
    return btn;
  }

  private startArrowScroll(dir: 1 | -1) {
    const strip = this.sys.chapterContainer;
    if (!strip || this.arrowRaf != null) return;
    // Time-based (frame-rate-independent) velocity that eases in, so a hold
    // ramps up smoothly instead of snapping straight to full speed. A small
    // starting floor keeps a quick tap responsive rather than barely moving.
    const MAX_V = 0.85; // px/ms at full speed (~850px/s)
    const RAMP_MS = 450; // time to reach full speed
    const BASE = 0.18; // fraction of MAX_V applied immediately
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let startTs: number | null = null;
    let lastTs = 0;
    const step = (ts: number) => {
      if (startTs == null) startTs = lastTs = ts;
      const dt = ts - lastTs;
      lastTs = ts;
      const t = reduce ? 1 : Math.min(1, (ts - startTs) / RAMP_MS);
      const eased = t * t * (3 - 2 * t); // smoothstep
      const v = MAX_V * (BASE + (1 - BASE) * eased);
      const max = strip.scrollWidth - strip.clientWidth;
      strip.scrollLeft = Math.max(0, Math.min(max, strip.scrollLeft + dir * v * dt));
      // Stop once we reach the edge we're heading toward (direction-aware, so
      // the first frame — when dt is 0 and we sit at scrollLeft 0 — doesn't
      // immediately satisfy a naive `<= 0` check and kill the hold).
      const atTargetEdge = dir > 0 ? strip.scrollLeft >= max : strip.scrollLeft <= 0;
      if (atTargetEdge) {
        this.stopArrowScroll();
        return;
      }
      this.arrowRaf = requestAnimationFrame(step);
    };
    this.arrowRaf = requestAnimationFrame(step);
  }

  private stopArrowScroll() {
    if (this.arrowRaf != null) {
      cancelAnimationFrame(this.arrowRaf);
      this.arrowRaf = null;
    }
  }

  private nudgeChapterStrip(dir: 1 | -1) {
    const strip = this.sys.chapterContainer;
    if (!strip) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    strip.scrollBy({
      left: dir * strip.clientWidth * 0.8,
      behavior: reduce ? "auto" : "smooth",
    });
  }

  // Toggle the strip's left/right fade masks (and the matching arrow's disabled
  // state) based on how much is scrolled out of view on each side, so the strip
  // only dissolves — and an arrow only stays live — where there's more to reach.
  private updateChapterFades() {
    const strip = this.sys.chapterContainer;
    if (!strip) return;
    const max = strip.scrollWidth - strip.clientWidth;
    // 1px slack absorbs sub-pixel rounding so a fully-scrolled edge reads as 0.
    const atStart = strip.scrollLeft <= 1;
    const atEnd = strip.scrollLeft >= max - 1;
    strip.style.setProperty("--fade-l", atStart ? "0px" : "var(--fade-w)");
    strip.style.setProperty("--fade-r", atEnd ? "0px" : "var(--fade-w)");
    if (this.prevArrow) this.prevArrow.disabled = atStart;
    if (this.nextArrow) this.nextArrow.disabled = atEnd;
    // Hide the arrow rail entirely when nothing overflows (CSS also gates it to
    // fine-pointer devices, so touch viewports never show arrows).
    this.navEl?.classList.toggle("has-overflow", max > 1);
  }

  // Bring the active chapter pill into the center of the horizontal strip,
  // scrolling only the strip (never the page — `block: nearest` and a
  // contained `scrollBy` avoid disturbing vertical position).
  private scrollPillIntoView(el: HTMLElement) {
    const strip = this.sys.chapterContainer;
    if (!strip) return;
    const stripRect = strip.getBoundingClientRect();
    const pillRect = el.getBoundingClientRect();
    const delta =
      pillRect.left - stripRect.left - (strip.clientWidth - el.clientWidth) / 2;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    strip.scrollBy({ left: delta, behavior: reduce ? "auto" : "smooth" });
  }

  updateActiveChapter() {
    if (!this.sys.manifest || !this.sys.player) return;
    const tMs = secondsToMs(asSeconds(this.sys.player.currentTime));
    const active = this.sys.manifest.chapters.find(
      (c) => tMs >= c.startTime && tMs < c.endTime,
    ) ?? this.sys.manifest.chapters[0];
    for (const [id, el] of this.pillEls) {
      const isActive = id === active?.id;
      el.toggleAttribute("data-active", isActive);
      el.setAttribute("aria-current", isActive ? "true" : "false");
    }
    // Keep the active pill in view, but only when the chapter actually
    // changed (this runs every rAF tick via updateActive).
    if (active && active.id !== this.lastActiveChapterId) {
      this.lastActiveChapterId = active.id;
      const el = this.pillEls.get(active.id);
      if (el) this.scrollPillIntoView(el);
    }
  }
}
