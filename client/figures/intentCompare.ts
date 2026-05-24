// Interactive figure for the intro post: "Two ways to run an exchange."
//
// A calm SIDE-BY-SIDE comparison (no tabs, no inline recolour/cancel churn)
// of running an exchange FULLY ON-CHAIN versus the INTENT model.
//
//   - Fully on-chain (LEFT): ONE column. Every action — place, cancel, replace —
//     is its own on-chain transaction, and they stack up in a single column.
//     Most never fill. A big counter climbs to "9 on-chain txs for 1 trade".
//   - Intent (RIGHT): TWO columns. An OFF-CHAIN column where orders are
//     broadcast and cancelled freely (labelled "free", no transactions) and an
//     ON-CHAIN column that stays empty until a match, when exactly ONE "settle"
//     tx appears. Counter: "1 on-chain tx".
//
// The whole point: in the intent model nearly everything happens off-chain and
// only the actual fill touches the chain. Columns build up in a staggered
// reveal rather than recolouring in place, so it reads cleanly. The animation
// auto-loops every few seconds and renders the final state under reduced-motion.
//
// External module for the same CSP reason as the other figures (see
// client/figures/hashAvalanche.ts). GSAP only writes CSSOM. Enhancement
// contract is identical to offerLifecycle.ts: static SVG fallback,
// `.intent-enhanced`, IntersectionObserver intro (once, threshold 0.3),
// `narration-active` replay via MutationObserver, reduced-motion aware.
import { gsap } from "gsap";

// A row that lands in a column. `kind` drives the row's look; `tx` whether it
// bumps the on-chain counter.
interface Row {
  label: string;
  kind: "tx" | "free" | "settle";
  tx: boolean;
}

// Fully on-chain: every order placement is its own transaction, and only the
// final pair actually trades. (We deliberately don't show "cancel" here —
// cancellation is its own on-chain tx, a point the post develops later.)
const ONCHAIN_ROWS: Row[] = [
  { label: "place buy 10", kind: "tx", tx: true },
  { label: "place sell 5", kind: "tx", tx: true },
  { label: "place buy 3", kind: "tx", tx: true },
  { label: "place sell 8", kind: "tx", tx: true },
  { label: "place buy 7", kind: "tx", tx: true },
  { label: "place sell 7", kind: "tx", tx: true },
  { label: "settle the trade", kind: "settle", tx: true },
];

// Intent, off-chain column: orders broadcast freely. No txs.
const INTENT_OFFCHAIN_ROWS: Row[] = [
  { label: "broadcast buy 10", kind: "free", tx: false },
  { label: "broadcast sell 5", kind: "free", tx: false },
  { label: "broadcast buy 3", kind: "free", tx: false },
  { label: "broadcast sell 8", kind: "free", tx: false },
  { label: "broadcast buy 7", kind: "free", tx: false },
  { label: "broadcast sell 7", kind: "free", tx: false },
];

// Intent, on-chain column: stays empty until the single match settles.
const INTENT_ONCHAIN_ROWS: Row[] = [
  { label: "settle the match", kind: "settle", tx: true },
];

const ONCHAIN_TX_TOTAL = ONCHAIN_ROWS.filter((r) => r.tx).length; // 9
const INTENT_TX_TOTAL = INTENT_ONCHAIN_ROWS.filter((r) => r.tx).length; // 1

const LOOP_GAP = 3.2; // seconds to dwell on the final state before replaying

function rowHtml(r: Row): string {
  return `<div class="row row-${r.kind}"><span class="row-dot"></span><span class="row-label">${r.label}</span></div>`;
}

function initFigure(figure: HTMLElement): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const stage = document.createElement("div");
  stage.className = "intent-fig";

  const onchainRows = ONCHAIN_ROWS.map(rowHtml).join("");
  const offRows = INTENT_OFFCHAIN_ROWS.map(rowHtml).join("");
  const intentOnRows = INTENT_ONCHAIN_ROWS.map(rowHtml).join("");

  stage.innerHTML = `
    <div class="compare">
      <section class="panel panel-onchain" aria-label="Fully on-chain">
        <h3 class="panel-title">Fully on-chain</h3>
        <div class="counter counter-hot" data-counter="onchain">
          <div class="counter-num" data-count="onchain">0</div>
          <div class="counter-label">on-chain txs</div>
        </div>
        <div class="cols cols-1">
          <div class="col col-chain">
            <div class="col-label">on-chain</div>
            <div class="col-rows" data-rows="onchain">${onchainRows}</div>
          </div>
        </div>
        <p class="panel-note">Every order you place is its own transaction, and most never fill &mdash; <b class="hot-text">${ONCHAIN_TX_TOTAL} on-chain txs for 1 trade</b>.</p>
      </section>
      <section class="panel panel-intent" aria-label="Intent">
        <h3 class="panel-title">Intent</h3>
        <div class="counter counter-cool" data-counter="intent">
          <div class="counter-num" data-count="intent">0</div>
          <div class="counter-label">on-chain txs</div>
        </div>
        <div class="cols cols-2">
          <div class="col col-off">
            <div class="col-label">off-chain <span class="tag tag-free">free</span></div>
            <div class="col-rows" data-rows="intent-off">${offRows}</div>
          </div>
          <div class="col col-chain">
            <div class="col-label">on-chain</div>
            <div class="col-rows" data-rows="intent-on">${intentOnRows}</div>
          </div>
        </div>
        <p class="panel-note">Orders are broadcast off-chain for free; only the actual match settles &mdash; <b class="cool-text">${INTENT_TX_TOTAL} on-chain tx</b>.</p>
      </section>
    </div>
    <div class="controls">
      <button type="button" class="replay" data-replay>&#9654; Replay</button>
    </div>`;

  const caption = figure.querySelector("figcaption");
  figure.insertBefore(stage, caption);
  figure.classList.add("intent-enhanced");

  const onchainCount = stage.querySelector<HTMLElement>('[data-count="onchain"]')!;
  const intentCount = stage.querySelector<HTMLElement>('[data-count="intent"]')!;
  const onchainCounter = stage.querySelector<HTMLElement>('[data-counter="onchain"]')!;
  const intentCounter = stage.querySelector<HTMLElement>('[data-counter="intent"]')!;
  const replayBtn = stage.querySelector<HTMLButtonElement>("[data-replay]")!;

  const onchainRowEls = Array.from(
    stage.querySelectorAll<HTMLElement>('[data-rows="onchain"] .row'),
  );
  const offRowEls = Array.from(
    stage.querySelectorAll<HTMLElement>('[data-rows="intent-off"] .row'),
  );
  const intentOnRowEls = Array.from(
    stage.querySelectorAll<HTMLElement>('[data-rows="intent-on"] .row'),
  );

  let tl: gsap.core.Timeline | null = null;

  const hideRows = (els: HTMLElement[]): void => {
    els.forEach((el) => { gsap.set(el, { opacity: 0, y: 8 }); });
  };

  const showRows = (els: HTMLElement[]): void => {
    els.forEach((el) => { gsap.set(el, { opacity: 1, y: 0 }); });
  };

  const reset = (): void => {
    tl?.kill();
    tl = null;
    hideRows(onchainRowEls);
    hideRows(offRowEls);
    hideRows(intentOnRowEls);
    onchainCount.textContent = "0";
    intentCount.textContent = "0";
    onchainCounter.classList.remove("active");
    intentCounter.classList.remove("active");
  };

  const finalState = (): void => {
    showRows(onchainRowEls);
    showRows(offRowEls);
    showRows(intentOnRowEls);
    onchainCount.textContent = String(ONCHAIN_TX_TOTAL);
    intentCount.textContent = String(INTENT_TX_TOTAL);
    onchainCounter.classList.add("active");
    intentCounter.classList.add("active");
  };

  // Reveal one row and, if it carries a tx, bump the matching counter.
  const revealRow = (
    t: gsap.core.Timeline,
    el: HTMLElement,
    countEl: HTMLElement | null,
    counterEl: HTMLElement | null,
    nextCount: number,
  ): void => {
    t.to(el, {
      opacity: 1,
      y: 0,
      duration: 0.32,
      ease: "back.out(1.8)",
    });
    if (countEl && counterEl) {
      t.add(() => {
        countEl.textContent = String(nextCount);
        counterEl.classList.add("active");
      });
      t.fromTo(counterEl, { scale: 1 }, { scale: 1.16, duration: 0.16, yoyo: true, repeat: 1, ease: "power2.out" });
    }
  };

  function play(): void {
    if (reduced) { reset(); finalState(); return; }
    reset();

    const t = gsap.timeline({
      onComplete() {
        // Auto-loop: dwell on the finished comparison, then replay.
        gsap.delayedCall(LOOP_GAP, play);
      },
    });
    tl = t;

    // Build the fully-on-chain column first: every row is a tx, the counter
    // climbs row by row. This is the "expensive" side.
    let onchainTx = 0;
    ONCHAIN_ROWS.forEach((r, i) => {
      onchainTx += r.tx ? 1 : 0;
      revealRow(t, onchainRowEls[i], r.tx ? onchainCount : null, r.tx ? onchainCounter : null, onchainTx);
      t.to({}, { duration: 0.12 });
    });

    // Small breath before the intent side.
    t.to({}, { duration: 0.35 });

    // Then the intent side: the off-chain column piles up for free (no counter
    // movement), and only the final settle bumps the on-chain counter to 1.
    INTENT_OFFCHAIN_ROWS.forEach((r, i) => {
      revealRow(t, offRowEls[i], null, null, 0);
      t.to({}, { duration: 0.1 });
    });
    t.to({}, { duration: 0.3 });
    let intentTx = 0;
    INTENT_ONCHAIN_ROWS.forEach((r, i) => {
      intentTx += r.tx ? 1 : 0;
      revealRow(t, intentOnRowEls[i], r.tx ? intentCount : null, r.tx ? intentCounter : null, intentTx);
    });
  }

  replayBtn.addEventListener("click", play);

  // Idle state before the first run.
  reset();

  // Silent reader: start when scrolled into view.
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.disconnect(); play(); }
  }, { threshold: 0.3 });
  io.observe(figure);

  // Listener: restart when narration reaches the paired mark.
  let active = figure.classList.contains("narration-active");
  const mo = new MutationObserver(() => {
    const now = figure.classList.contains("narration-active");
    if (now && !active) play();
    active = now;
  });
  mo.observe(figure, { attributes: true, attributeFilter: ["class"] });
}

// Run-guard MUST stay at the bottom: the const arrow helpers above are not
// hoisted, so calling initFigure earlier would throw before they're defined.
const fig = document.getElementById("intent-figure");
if (fig) { try { initFigure(fig); } catch (e) { console.error("intentCompare figure failed", e); } }
