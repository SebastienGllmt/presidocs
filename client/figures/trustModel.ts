// Interactive figure for the trust-model contrast: how two L2 designs layer
// their two guarantees (INTEGRITY = can a withdrawal be forged; PRIVACY = are
// balances hidden), and which layer the L1 ultimately trusts.
//
// The point is that each design WRAPS one guarantee inside the other, and the
// OUTER layer is the one the L1 trusts for integrity:
//
//   - Midnight City: cryptographic PRIVACY (Ligero) wrapped in TEE INTEGRITY.
//     Outer = TEE (amber). Inner = crypto proof (purple). Break the TEE →
//     forged withdrawals (bad / red consequence).
//   - zSwap L2 (ours): cryptographic INTEGRITY (recursive SNARK) wrapped around
//     a TEE used only for PRIVACY. Outer = SNARK (purple). Inner = TEE (amber).
//     Break the TEE → lost privacy, never funds (good / green consequence).
//
// Same two tools, opposite arrangement: a consistent color per mechanism
// (crypto = purple, TEE = amber) makes the layers visibly SWAP between columns.
//
// External module for the same CSP reason as the other figures (see
// client/figures/hashAvalanche.ts). GSAP writes CSSOM only. Progressive
// enhancement over a static SVG: `.tm-enhanced`, IntersectionObserver intro,
// `narration-active` replay, reduced-motion aware, auto-loops while in view.
import { gsap } from "gsap";

interface Column {
  name: string;
  outerLabel: string; // "Integrity: …"
  outerMech: string; // text inside the outer box body
  innerLabel: string; // "Privacy: …" (col 1) or "Privacy: …" (col 2)
  innerMech: string; // text inside the inner box body
  outerKind: "crypto" | "tee"; // drives outer color
  innerKind: "crypto" | "tee"; // drives inner color
  note: string; // consequence line
  noteKind: "bad" | "good";
}

const COLUMNS: Column[] = [
  {
    name: "Midnight City",
    outerLabel: "Integrity",
    outerMech: "TEE<br /><small>trusted hardware enclave</small>",
    outerKind: "tee",
    innerLabel: "Privacy",
    innerMech: "cryptographic proof<br /><small>Ligero proof system</small>",
    innerKind: "crypto",
    note: "Break the TEE &rarr; <b>forged withdrawals</b>: integrity fails, funds at risk.",
    noteKind: "bad",
  },
  {
    name: "zSwap L2 (ours)",
    outerLabel: "Integrity",
    outerMech: "cryptographic proof<br /><small>recursive SNARK &middot; math</small>",
    outerKind: "crypto",
    innerLabel: "Privacy",
    innerMech: "TEE<br /><small>holds users' viewing keys</small>",
    innerKind: "tee",
    note: "Break the TEE &rarr; <b>lost privacy, never funds</b>: integrity is math, unforgeable.",
    noteKind: "good",
  },
];

function initFigure(figure: HTMLElement): void {
  // Intentionally static: this contrast reads better as a still, so we always
  // render the final, fully-built frame and never animate or loop. (Every entry
  // point — initial, scroll-in, narration — funnels through play() → showFinal().)
  const reduced = true;

  const stage = document.createElement("div");
  stage.className = "tm-fig";

  const parts: string[] = [];
  parts.push(
    `<div class="tm-legend">
       <span class="tm-key"><span class="tm-swatch crypto"></span>cryptographic (math)</span>
       <span class="tm-key"><span class="tm-swatch tee"></span>TEE (hardware trust)</span>
     </div>`,
  );
  parts.push('<div class="tm-cols">');
  COLUMNS.forEach((c, i) => {
    parts.push(
      `<div class="tm-col" data-col="${i}">
         <div class="tm-col-name">${c.name}</div>
         <div class="tm-outer ${c.outerKind}" data-outer>
           <div class="tm-layer-label">${c.outerLabel}: <span class="tm-trusted">L1 trusts this</span></div>
           <div class="tm-box-body">${c.outerMech}</div>
           <div class="tm-inner ${c.innerKind}" data-inner>
             <div class="tm-layer-label">${c.innerLabel}</div>
             <div class="tm-box-body">${c.innerMech}</div>
           </div>
         </div>
         <p class="tm-note ${c.noteKind}" data-note>${c.note}</p>
       </div>`,
    );
  });
  parts.push("</div>");
  parts.push(
    `<p class="tm-takeaway">Same two tools, opposite arrangement &mdash; putting the cryptographic guarantee on the <b>outside</b> (integrity) is what makes a TEE breach cost only privacy, not funds.</p>`,
  );
  stage.innerHTML = parts.join("");

  const caption = figure.querySelector("figcaption");
  figure.insertBefore(stage, caption);
  figure.classList.add("tm-enhanced");

  const colEls = Array.from(stage.querySelectorAll<HTMLElement>(".tm-col"));
  const outerEls = Array.from(stage.querySelectorAll<HTMLElement>("[data-outer]"));
  const innerEls = Array.from(stage.querySelectorAll<HTMLElement>("[data-inner]"));
  const noteEls = Array.from(stage.querySelectorAll<HTMLElement>("[data-note]"));

  let tl: gsap.core.Timeline | null = null;
  let loopTimer: gsap.core.Tween | null = null;

  // Show the final, fully-built state (used for reduced-motion and as a base).
  const showFinal = (): void => {
    outerEls.forEach((el) => { el.style.opacity = "1"; el.style.transform = "scale(1)"; el.classList.add("built"); });
    innerEls.forEach((el) => { el.style.opacity = "1"; el.style.transform = "scale(1)"; el.classList.add("built"); });
    noteEls.forEach((el) => { el.style.opacity = "1"; el.classList.add("built"); });
  };

  const reset = (): void => {
    tl?.kill();
    tl = null;
    loopTimer?.kill();
    loopTimer = null;
    outerEls.forEach((el) => el.classList.remove("built"));
    innerEls.forEach((el) => el.classList.remove("built"));
    noteEls.forEach((el) => el.classList.remove("built"));
    // Start state: inner hidden, outer hidden, note hidden.
    innerEls.forEach((el) => { el.style.opacity = "0"; el.style.transform = "scale(0.85)"; });
    outerEls.forEach((el) => { el.style.opacity = "0"; el.style.transform = "scale(1.12)"; });
    noteEls.forEach((el) => { el.style.opacity = "0"; });
  };

  const play = (): void => {
    if (reduced) { showFinal(); return; }
    reset();
    const t = gsap.timeline({
      onComplete: () => {
        // Auto-loop after a few seconds so it replays indefinitely.
        loopTimer = gsap.delayedCall(3.5, play);
      },
    });
    tl = t;
    colEls.forEach((_col, i) => {
      const inner = innerEls[i]!;
      const outer = outerEls[i]!;
      const note = noteEls[i]!;
      // 1. Draw the inner box.
      t.to(inner, {
        opacity: 1, scale: 1, duration: 0.45, ease: "back.out(2)",
        onStart() { inner.classList.add("built"); },
      }, i === 0 ? 0 : ">+0.15");
      // 2. Wrap the outer box around it (scales down from larger, fades in).
      t.to(outer, {
        opacity: 1, scale: 1, duration: 0.55, ease: "power3.out",
        onStart() { outer.classList.add("built"); },
      }, ">-0.05");
      // 3. Reveal the consequence note.
      t.to(note, {
        opacity: 1, duration: 0.4, ease: "power1.out",
        onStart() { note.classList.add("built"); },
      }, ">-0.1");
    });
  };

  // Silent reader: play once when scrolled into view (then it auto-loops).
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

// Run-guard LAST: initFigure is a `function` (hoisted), but keeping the entry
// point at the very bottom matches the house contract and is safe regardless
// of whether helpers are const-arrows or declarations.
const fig = document.getElementById("trustmodel-figure");
if (fig) {
  try {
    initFigure(fig);
  } catch (e) {
    console.error("trustModel figure failed", e);
  }
}
