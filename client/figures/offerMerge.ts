// Interactive "offer merge" figure for posts/offer-files.html.
//
// Teaches the conceptual heart of a zSwap offer: an offer is an *imbalanced*
// partial transaction, described by a signed per-token delta map. A maker's
// posted offer and a taker's matching half MERGE (set-union of inputs/outputs,
// element-wise sum of deltas) into one transaction — which is only valid when
// every token's merged delta nets to zero. The reader drives the taker's half
// and watches the ledger snap to "balanced".
//
// Why an external module (not an inline <script>): production CSP is
// `script-src 'self'` with no 'unsafe-inline' (see shared/securityHeaders.ts).
// The post references this file with <script type="module" src="…">, which
// Bun's bundler emits as a hashed same-origin asset — CSP-clean. GSAP only
// writes element.style (CSSOM), which CSP does not govern.
//
// Same enhancement contract as client/figures/hashAvalanche.ts:
//   - progressive enhancement over a static SVG fallback (adds `.merge-enhanced`)
//   - narration-synced via the `narration-active` class the player toggles
//   - IntersectionObserver intro for the silent reader
//   - reduced-motion aware
import { gsap } from "gsap";

// Alice's posted offer is fixed: she puts 5 NIGHT into the pot and pulls 3 STAR
// out. Expressed as the offer's net contribution per token (its delta):
const MAKER_NIGHT = 5; // +5 NIGHT contributed
const MAKER_STAR = 3; // −3 STAR withdrawn
const MAX = 9;

const fig = document.getElementById("merge-figure");
if (fig) initMergeFigure(fig);

function initMergeFigure(figure: HTMLElement): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const stage = document.createElement("div");
  stage.className = "merge-fig";
  stage.innerHTML = `
    <div class="offers">
      <div class="offer-card maker" data-maker>
        <div class="offer-head">Alice's offer <span class="badge">on the bulletin board</span></div>
        <ul class="legs">
          <li class="leg"><span class="dir give">gives</span><span class="amt">5</span><span class="tok night">🌙 NIGHT</span></li>
          <li class="leg"><span class="dir want">wants</span><span class="amt">3</span><span class="tok star">⭐ STAR</span></li>
        </ul>
      </div>
      <div class="merge-op" data-op>+</div>
      <div class="offer-card taker" data-taker>
        <div class="offer-head">Your matching half <span class="badge flip">Alice's offer, flipped</span></div>
        <div class="stepper-row">
          <span class="dir want">take</span>
          <button type="button" class="step" data-dec="night" aria-label="take one less NIGHT">−</button>
          <span class="amt" data-night>5</span>
          <button type="button" class="step" data-inc="night" aria-label="take one more NIGHT">+</button>
          <span class="tok night">🌙 NIGHT</span>
        </div>
        <div class="stepper-row">
          <span class="dir give">give</span>
          <button type="button" class="step" data-dec="star" aria-label="give one less STAR">−</button>
          <span class="amt" data-star>3</span>
          <button type="button" class="step" data-inc="star" aria-label="give one more STAR">+</button>
          <span class="tok star">⭐ STAR</span>
        </div>
      </div>
    </div>
    <div class="ledger" data-ledger>
      <div class="ledger-title">merged transaction &mdash; every token's &Delta; must net to zero</div>
      <div class="delta-rows">
        <div class="delta-row"><span class="tok night">🌙 NIGHT</span><span class="bar"><span class="fill" data-bar-night></span></span><span class="delta" data-delta-night></span></div>
        <div class="delta-row"><span class="tok star">⭐ STAR</span><span class="bar"><span class="fill" data-bar-star></span></span><span class="delta" data-delta-star></span></div>
      </div>
      <p class="verdict" data-verdict></p>
    </div>`;

  const caption = figure.querySelector("figcaption");
  figure.insertBefore(stage, caption);
  figure.classList.add("merge-enhanced");

  const q = <T extends Element>(sel: string) => stage.querySelector(sel) as T;
  const nightEl = q<HTMLElement>("[data-night]");
  const starEl = q<HTMLElement>("[data-star]");
  const dNight = q<HTMLElement>("[data-delta-night]");
  const dStar = q<HTMLElement>("[data-delta-star]");
  const barNight = q<HTMLElement>("[data-bar-night]");
  const barStar = q<HTMLElement>("[data-bar-star]");
  const verdict = q<HTMLElement>("[data-verdict]");
  const op = q<HTMLElement>("[data-op]");
  const ledger = q<HTMLElement>("[data-ledger]");

  // Taker's half: how much NIGHT it takes, how much STAR it gives.
  let nightTake = MAKER_NIGHT;
  let starGive = MAKER_STAR;
  let wasBalanced = true;

  const clamp = (n: number) => Math.max(0, Math.min(MAX, n));

  function paintDelta(el: HTMLElement, bar: HTMLElement, delta: number): void {
    el.textContent = (delta > 0 ? "+" : "") + delta;
    el.classList.toggle("surplus", delta > 0);
    el.classList.toggle("deficit", delta < 0);
    el.classList.toggle("zero", delta === 0);
    // Bar fills proportionally to |delta| (max 9), colored by sign.
    const pct = Math.min(100, (Math.abs(delta) / MAX) * 100);
    bar.classList.toggle("surplus", delta > 0);
    bar.classList.toggle("deficit", delta < 0);
    bar.classList.toggle("zero", delta === 0);
    if (reduced) bar.style.width = pct + "%";
    else gsap.to(bar, { width: pct + "%", duration: 0.35, ease: "power2.out" });
  }

  function render(animateBalance: boolean): void {
    nightEl.textContent = String(nightTake);
    starEl.textContent = String(starGive);

    const mergedNight = MAKER_NIGHT - nightTake; // +5 from Alice, −take from you
    const mergedStar = starGive - MAKER_STAR; // −3 from Alice, +give from you
    paintDelta(dNight, barNight, mergedNight);
    paintDelta(dStar, barStar, mergedStar);

    const balanced = mergedNight === 0 && mergedStar === 0;
    figure.classList.toggle("is-balanced", balanced);
    op.textContent = balanced ? "=" : "+";
    verdict.innerHTML = balanced
      ? "&check; <b>Balanced.</b> The two halves merge into one transaction that settles atomically on Midnight. <b>Press the &minus;/+ buttons</b> to unbalance it and watch it break."
      : "&times; <b>Imbalanced.</b> A non-zero &Delta; can't be submitted &mdash; mirror Alice's offer exactly to fix it.";

    if (balanced && animateBalance && !wasBalanced && !reduced) {
      gsap.fromTo(ledger, { scale: 0.97 }, { scale: 1, duration: 0.4, ease: "back.out(2.2)" });
      gsap.fromTo(op, { scale: 0.5, rotation: -20 }, { scale: 1, rotation: 0, duration: 0.45, ease: "back.out(3)" });
    }
    wasBalanced = balanced;
  }

  stage.querySelectorAll<HTMLButtonElement>(".step").forEach((btn) => {
    btn.addEventListener("click", () => {
      const inc = btn.dataset.inc;
      const dec = btn.dataset.dec;
      const tok = inc ?? dec;
      const sign = inc ? 1 : -1;
      if (tok === "night") nightTake = clamp(nightTake + sign);
      else starGive = clamp(starGive + sign);
      render(true);
    });
  });

  function intro(): void {
    if (reduced) { render(false); return; }
    const legs = stage.querySelectorAll(".maker .leg, .taker .stepper-row");
    gsap.from(legs, { opacity: 0, y: 12, duration: 0.3, stagger: 0.07, ease: "back.out(2)" });
    render(false);
  }

  // Silent reader: play once when scrolled into view.
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.disconnect(); intro(); }
  }, { threshold: 0.3 });
  io.observe(figure);

  // Listener: replay when narration reaches the paired mark.
  let active = figure.classList.contains("narration-active");
  const mo = new MutationObserver(() => {
    const now = figure.classList.contains("narration-active");
    if (now && !active) intro();
    active = now;
  });
  mo.observe(figure, { attributes: true, attributeFilter: ["class"] });

  render(false);
}
