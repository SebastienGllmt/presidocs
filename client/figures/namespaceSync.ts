// Animated "namespace advantage" figure for the presidocs blog.
//
// A side-by-side contrast of what a client must download to read just YOUR
// app's data:
//
//   LEFT  — Ethereum (monolithic): app data is calldata buried inside a tall
//           stack of mixed transactions. To read your slice you must sync the
//           WHOLE chain — every block, every unrelated tx. Heavy and slow.
//
//   RIGHT — Celestia (namespaces): block data is partitioned into per-app
//           lanes. A client samples ONLY the one namespace it cares about (the
//           Offer-File lane, highlighted in blurple), pulling it out cleanly
//           while everything else is ignored. Light and fast.
//
// The animation makes the asymmetry the point: on the left a cursor laboriously
// ingests the entire stack; on the right a cursor grabs only the highlighted
// lane and skips the rest. It AUTO-LOOPS every few seconds, indefinitely.
//
// External module for the same CSP reason as the other figures (see
// client/figures/hashAvalanche.ts): production runs `style-src 'self'` with no
// 'unsafe-inline', so all dynamics are class toggles and GSAP CSSOM writes —
// no inline style=, no inline <script>/<style>. Enhancement contract matches
// the house pattern: static SVG fallback, `.ns-enhanced`, IntersectionObserver
// intro, `narration-active` replay, reduced-motion aware.
import { gsap } from "gsap";

// One row per "chain row" in each stack. `mine` marks the rows that belong to
// YOUR app's namespace (the Offer-File lane); everything else is unrelated.
interface Row {
  mine: boolean;
}

// A column of mixed rows. The same logical data on both sides — only the
// access pattern differs.
const ROWS: Row[] = [
  { mine: false },
  { mine: true },
  { mine: false },
  { mine: false },
  { mine: false },
  { mine: true },
  { mine: false },
  { mine: false },
  { mine: true },
  { mine: false },
];

const LOOP_GAP = 2.2; // seconds of dwell on the finished frame before replay

// --- helpers (const-arrow; NOT hoisted — must stay above the run-guard) ---

// Build the HTML for one stack of rows. `side` distinguishes left/right so the
// CSS can theme them and so we can query them independently.
const buildStack = (side: "eth" | "tia"): string => {
  const rows = ROWS.map((r, i) => {
    const cls = r.mine ? "ns-row mine" : "ns-row";
    return `<div class="${cls}" data-row="${i}" data-mine="${r.mine ? "1" : "0"}"></div>`;
  }).join("");
  return `
    <div class="ns-side ${side}" data-side="${side}">
      <div class="ns-head">
        <span class="ns-chain">${side === "eth" ? "Ethereum" : "Celestia"}</span>
        <span class="ns-sub">${side === "eth" ? "monolithic" : "namespaces"}</span>
      </div>
      <div class="ns-stack" data-stack="${side}">
        <div class="ns-cursor" data-cursor="${side}"></div>
        ${rows}
      </div>
      <div class="ns-foot" data-foot="${side}"></div>
    </div>`;
};

// Reset every animated property back to the pre-play state via CSSOM.
const resetSide = (rows: HTMLElement[], cursor: HTMLElement, foot: HTMLElement): void => {
  rows.forEach((r) => {
    r.classList.remove("pulled", "skipped", "scanning");
    r.style.opacity = "";
    r.style.transform = "";
  });
  cursor.style.opacity = "0";
  cursor.style.transform = "";
  foot.classList.remove("done");
};

// Render the finished frame statically (used for reduced-motion and as the
// resting state). LEFT: every row ingested. RIGHT: only `mine` rows pulled,
// the rest greyed out.
const showFinal = (
  ethRows: HTMLElement[], ethCursor: HTMLElement, ethFoot: HTMLElement,
  tiaRows: HTMLElement[], tiaCursor: HTMLElement, tiaFoot: HTMLElement,
): void => {
  resetSide(ethRows, ethCursor, ethFoot);
  resetSide(tiaRows, tiaCursor, tiaFoot);
  ethRows.forEach((r) => r.classList.add("pulled"));
  ethFoot.classList.add("done");
  tiaRows.forEach((r) => {
    if (r.dataset.mine === "1") r.classList.add("pulled");
    else r.classList.add("skipped");
  });
  tiaFoot.classList.add("done");
};

// --- the enhancement entry point (function decl — hoisting-safe) ---

function initFigure(figure: HTMLElement): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const stage = document.createElement("div");
  stage.className = "ns-fig";
  stage.innerHTML = `
    <div class="ns-board">
      ${buildStack("eth")}
      ${buildStack("tia")}
    </div>
    <p class="ns-takeaway">
      With namespaces you sync only the <b>Offer-File lane</b>, not the whole chain
      &mdash; full-node-grade assurance from a light node.
    </p>`;

  const caption = figure.querySelector("figcaption");
  figure.insertBefore(stage, caption);
  figure.classList.add("ns-enhanced");

  const q = <T extends Element>(sel: string): T => stage.querySelector(sel) as T;
  const all = (sel: string): HTMLElement[] =>
    Array.from(stage.querySelectorAll<HTMLElement>(sel));

  const ethRows = all('.ns-side.eth .ns-row');
  const tiaRows = all('.ns-side.tia .ns-row');
  const ethCursor = q<HTMLElement>('[data-cursor="eth"]');
  const tiaCursor = q<HTMLElement>('[data-cursor="tia"]');
  const ethFoot = q<HTMLElement>('[data-foot="eth"]');
  const tiaFoot = q<HTMLElement>('[data-foot="tia"]');
  const ethStack = q<HTMLElement>('[data-stack="eth"]');
  const tiaStack = q<HTMLElement>('[data-stack="tia"]');

  // Static footer labels for the resting/reduced-motion frame.
  const setFootText = (): void => {
    ethFoot.innerHTML = 'sync everything &rarr; <b>GBs</b>';
    tiaFoot.innerHTML = 'sync just your namespace &rarr; <b>tiny</b>';
  };
  setFootText();

  let tl: gsap.core.Timeline | null = null;

  // Vertical centre of a row relative to its stack, so the cursor can ride it.
  const rowCenterY = (stackEl: HTMLElement, row: HTMLElement): number =>
    row.offsetTop + row.offsetHeight / 2 - stackEl.clientHeight / 2;

  function play(): void {
    tl?.kill();
    setFootText();

    if (reduced) {
      showFinal(ethRows, ethCursor, ethFoot, tiaRows, tiaCursor, tiaFoot);
      return;
    }

    resetSide(ethRows, ethCursor, ethFoot);
    resetSide(tiaRows, tiaCursor, tiaFoot);

    const t = gsap.timeline({
      repeat: -1,
      repeatDelay: LOOP_GAP,
      onRepeat() {
        resetSide(ethRows, ethCursor, ethFoot);
        resetSide(tiaRows, tiaCursor, tiaFoot);
      },
    });
    tl = t;

    // Reveal both cursors at the top of their stacks.
    t.set([ethCursor, tiaCursor], { opacity: 1, y: rowCenterY(ethStack, ethRows[0]) });

    // LEFT (Ethereum): the cursor crawls down EVERY row, ingesting each one.
    // This is the slow path — it has to touch all of them.
    const ethPer = 0.42;
    ethRows.forEach((row, i) => {
      const startAt = i * ethPer;
      t.to(ethCursor, {
        y: rowCenterY(ethStack, row),
        duration: ethPer * 0.6,
        ease: "none",
      }, startAt);
      t.add(() => {
        row.classList.add("scanning");
        row.classList.add("pulled");
      }, startAt + ethPer * 0.5);
    });
    const ethEnd = ethRows.length * ethPer;
    t.add(() => ethFoot.classList.add("done"), ethEnd);

    // RIGHT (Celestia): the cursor visits ONLY the highlighted namespace rows,
    // pulling each cleanly; the rest grey out immediately and are skipped.
    // All of this runs in parallel with the left side (note absolute times),
    // and finishes far sooner — making the asymmetry obvious.
    tiaRows.forEach((row) => {
      if (row.dataset.mine !== "1") {
        t.add(() => row.classList.add("skipped"), 0.15);
      }
    });
    const mineRows = tiaRows.filter((r) => r.dataset.mine === "1");
    const tiaPer = 0.5;
    mineRows.forEach((row, i) => {
      const startAt = 0.25 + i * tiaPer;
      t.to(tiaCursor, {
        y: rowCenterY(tiaStack, row),
        duration: tiaPer * 0.55,
        ease: "power1.inOut",
      }, startAt);
      t.add(() => {
        row.classList.add("scanning");
        row.classList.add("pulled");
      }, startAt + tiaPer * 0.45);
    });
    const tiaEnd = 0.25 + mineRows.length * tiaPer;
    t.add(() => tiaFoot.classList.add("done"), tiaEnd);

    // Park the right cursor (it's idle while the left keeps grinding).
    t.to(tiaCursor, { opacity: 0, duration: 0.3 }, tiaEnd);
    // Hide the left cursor only once it has finished the whole stack.
    t.to(ethCursor, { opacity: 0, duration: 0.3 }, ethEnd);
  }

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

// --- run-guard: MUST stay at the very bottom, after the const-arrow helpers
// above (which are not hoisted). `initFigure` is a function decl so it's safe
// to reference here. ---
const fig = document.getElementById("namespace-figure");
if (fig) {
  try {
    initFigure(fig);
  } catch (e) {
    console.error("namespaceSync figure failed", e);
  }
}
