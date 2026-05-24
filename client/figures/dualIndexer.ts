// Animated "indexing two chains into one order book" figure.
//
// The EffectStream framework watches BOTH source chains as a single ordered
// stream and reconciles them into one live order book: Celestia tells you what
// was CREATED (new offers), Midnight tells you what's now DEAD (spent UTXOs —
// fills & expiries). One program, two inputs, one book.
//
// Chips travel from the two streams into the EffectStream box, then the book
// updates: a Celestia "offer" chip ADDS an entry; a Midnight "spend" chip
// STRIKES the matching entry (greyed out — the offer is dead/filled).
//
// External module for the same CSP reason as the other figures (see
// client/figures/hashAvalanche.ts). GSAP writes CSSOM only. Enhancement
// contract is identical: static SVG fallback, `.idx-enhanced`,
// IntersectionObserver intro, `narration-active` replay, reduced-motion aware.
import { gsap } from "gsap";

type Source = "celestia" | "midnight";

interface Event {
  source: Source;
  // The order-book entry this event refers to (by id). Offers add; spends strike.
  id: string;
  // Short bech32m-style tag shown on the chip and book row.
  tag: string;
}

// Scripted stream of events. Offers (Celestia) and spends (Midnight) interleave;
// each spend targets an offer that was added earlier.
const EVENTS: Event[] = [
  { source: "celestia", id: "a", tag: "zswapoffer1qx7a…" },
  { source: "celestia", id: "b", tag: "zswapoffer1m4k9…" },
  { source: "midnight", id: "a", tag: "zswapoffer1qx7a…" },
  { source: "celestia", id: "c", tag: "zswapoffer1p0vd…" },
  { source: "midnight", id: "b", tag: "zswapoffer1m4k9…" },
  { source: "celestia", id: "d", tag: "zswapoffer1h8nz…" },
];

const CAPTIONS: Record<string, string> = {
  intro: "One program watches both chains as a single ordered stream.",
  celestia: "Celestia: a new offer. EffectStream adds it to the book.",
  midnight: "Midnight: that UTXO was spent. The offer is now dead &mdash; strike it.",
  done: "Celestia says what was created, Midnight says what's now dead. One reconciled book.",
};

function initIndexer(figure: HTMLElement): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const stage = document.createElement("div");
  stage.className = "idx-fig";
  stage.innerHTML = `
    <div class="idx-stage">
      <div class="idx-streams">
        <div class="idx-stream celestia" data-stream-celestia>
          <div class="idx-stream-label"><span class="idx-dot"></span>Celestia &mdash; new offers</div>
          <div class="idx-track" data-track-celestia></div>
        </div>
        <div class="idx-stream midnight" data-stream-midnight>
          <div class="idx-stream-label"><span class="idx-dot"></span>Midnight &mdash; spent UTXOs</div>
          <div class="idx-track" data-track-midnight></div>
        </div>
      </div>
      <div class="idx-box" data-box>
        <div class="idx-box-title">EffectStream</div>
        <div class="idx-box-sub">framework</div>
      </div>
      <div class="idx-book" data-book-wrap>
        <div class="idx-book-title">live order book</div>
        <ul class="idx-book-list" data-book></ul>
      </div>
    </div>
    <div class="idx-controls">
      <button type="button" class="idx-replay" data-replay>&#9654; Play the stream</button>
      <p class="idx-caption" data-caption>${CAPTIONS.intro}</p>
    </div>`;

  const caption = figure.querySelector("figcaption");
  figure.insertBefore(stage, caption);
  figure.classList.add("idx-enhanced");

  const q = <T extends Element>(s: string) => stage.querySelector(s) as T;
  const trackCel = q<HTMLElement>("[data-track-celestia]");
  const trackMid = q<HTMLElement>("[data-track-midnight]");
  const box = q<HTMLElement>("[data-box]");
  const book = q<HTMLElement>("[data-book]");
  const captionEl = q<HTMLElement>("[data-caption]");
  const replayBtn = q<HTMLButtonElement>("[data-replay]");

  let tl: gsap.core.Timeline | null = null;

  const makeChip = (ev: Event): HTMLElement => {
    const chip = document.createElement("div");
    chip.className = `idx-chip ${ev.source}`;
    const verb = ev.source === "celestia" ? "offer" : "spend";
    chip.innerHTML = `<span class="idx-chip-verb">${verb}</span><span class="idx-chip-tag">${ev.tag}</span>`;
    return chip;
  };

  const makeRow = (ev: Event): HTMLElement => {
    const row = document.createElement("li");
    row.className = "idx-row";
    row.dataset.id = ev.id;
    row.innerHTML = `<span class="idx-row-mark">&#9679;</span><span class="idx-row-tag">${ev.tag}</span>`;
    return row;
  };

  function reset(): void {
    tl?.kill();
    trackCel.innerHTML = "";
    trackMid.innerHTML = "";
    book.innerHTML = "";
    box.classList.remove("idx-pulse");
    captionEl.innerHTML = CAPTIONS.intro;
  }

  // Final, fully-reconciled state for reduced-motion / fallback.
  function renderFinal(): void {
    reset();
    EVENTS.forEach((ev) => {
      if (ev.source === "celestia") {
        const row = makeRow(ev);
        book.appendChild(row);
      } else {
        const row = book.querySelector<HTMLElement>(`.idx-row[data-id="${ev.id}"]`);
        if (row) row.classList.add("idx-dead");
      }
    });
    captionEl.innerHTML = CAPTIONS.done;
  }

  function play(): void {
    if (reduced) { renderFinal(); return; }
    reset();
    // Auto-loop: once the stream finishes, pause a beat and replay from scratch.
    const t = gsap.timeline({ onComplete: () => { gsap.delayedCall(2.5, play); } });
    tl = t;

    EVENTS.forEach((ev) => {
      const track = ev.source === "celestia" ? trackCel : trackMid;
      const chip = makeChip(ev);
      track.appendChild(chip);

      // Chip enters its stream track, then flies into the EffectStream box.
      t.add(() => { captionEl.innerHTML = CAPTIONS[ev.source]; });
      t.fromTo(chip, { x: -24, opacity: 0 }, {
        x: 0, opacity: 1, duration: 0.35, ease: "power2.out",
      });
      t.to(chip, { duration: 0.45 }); // dwell so the chip is readable
      t.to(chip, {
        opacity: 0, scale: 0.6, duration: 0.4, ease: "power2.in",
        onComplete() { chip.remove(); },
      });

      // Box pulses as it ingests the event.
      t.add(() => {
        box.classList.add("idx-pulse");
        gsap.delayedCall(0.4, () => box.classList.remove("idx-pulse"));
      });

      // Book reacts: add on offer, strike on spend.
      if (ev.source === "celestia") {
        const row = makeRow(ev);
        t.add(() => book.appendChild(row));
        // Reveal with transforms only (opacity/translate/scale) — never `height`,
        // whose `back.out` overshoot transiently grew the book and shifted the
        // page. The book reserves space for all rows (CSS min-height), so
        // appending never changes the figure's height either.
        t.fromTo(row, { opacity: 0, y: 8, scale: 0.96 }, {
          opacity: 1, y: 0, scale: 1, duration: 0.4, ease: "back.out(1.8)",
        });
      } else {
        t.add(() => {
          const row = book.querySelector<HTMLElement>(`.idx-row[data-id="${ev.id}"]`);
          if (row) row.classList.add("idx-dead");
        });
        t.to({}, { duration: 0.4 });
      }
    });

    t.add(() => { captionEl.innerHTML = CAPTIONS.done; });
  }

  replayBtn.addEventListener("click", play);

  // Silent reader: play once when scrolled into view.
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.disconnect(); play(); }
  }, { threshold: 0.3 });
  io.observe(figure);

  // Listener: replay when narration reaches the paired mark.
  let active = figure.classList.contains("narration-active");
  const mo = new MutationObserver(() => {
    const now = figure.classList.contains("narration-active");
    if (now && !active) play();
    active = now;
  });
  mo.observe(figure, { attributes: true, attributeFilter: ["class"] });
}

// Run-guard at the very bottom: all const arrow helpers above are defined by
// now (const arrows are not hoisted), so initIndexer can safely reference them.
const fig = document.getElementById("indexer-figure");
if (fig) { try { initIndexer(fig); } catch (e) { console.error("dualIndexer figure failed", e); } }
