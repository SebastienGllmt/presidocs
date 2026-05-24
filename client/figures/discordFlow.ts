// Animated "trade an offer over Discord" figure for the presidocs blog.
//
// Layout (per author feedback): the ONLY horizontal line runs between the two
// users, with the Discord #offers pill sitting in the MIDDLE of that line. Each
// user has a wallet stacked vertically beneath them. The offer chip travels:
// A's wallet → User A → (right, along the line) → the #offers pill → User B →
// B's wallet, where it settles. Takeaway: paste an offer file into Discord and a
// friend can take it — no escrow, more private. AUTO-LOOPS indefinitely.
//
// External module for the same CSP reason as the other figures: production CSP
// is `style-src 'self'` with no 'unsafe-inline', so dynamic visuals are class
// toggles + GSAP CSSOM writes only — no inline style=, no inline <script>/
// <style>. Enhancement contract matches the house pattern: static SVG fallback,
// `.dc-enhanced`, IntersectionObserver intro, `narration-active` replay,
// reduced-motion aware.
import { gsap } from "gsap";

const STEPS: string[] = [
  "User A's wallet builds and proves an offer &mdash; a self-contained <code>zswapoffer1…</code> file. No chain touched, no escrow.",
  "A pastes it straight into the shared Discord channel <code>#offers</code> &mdash; it's just text, nothing custodial in between.",
  "User B spots it in <code>#offers</code> and takes the <code>zswapoffer1…</code> string.",
  "B drops it into their wallet, merges the matching half, and it settles &mdash; peer-to-peer, no escrow, more private.",
];

function initFigure(figure: HTMLElement): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const stage = document.createElement("div");
  stage.className = "dc-fig";
  stage.innerHTML = `
    <div class="dc-stage" data-stage>
      <div class="dc-row">
        <div class="dc-user" data-user-a><span class="dc-glyph">&#128100;</span><span class="dc-lbl">User A</span></div>
        <div class="dc-mid">
          <div class="dc-hline">
            <span class="dc-half"><span class="dc-fill" data-fill-l></span></span>
            <span class="dc-half"><span class="dc-fill" data-fill-r></span></span>
          </div>
          <div class="dc-channel" data-channel>
            <span class="dc-ch-glyph" aria-hidden="true">&#9000;</span>
            <span class="dc-ch-pill">#offers</span>
          </div>
        </div>
        <div class="dc-user" data-user-b><span class="dc-glyph">&#128100;</span><span class="dc-lbl">User B</span></div>
        <div class="dc-wallet" data-wallet-a><span class="dc-glyph">&#128091;</span><span class="dc-lbl">Wallet</span></div>
        <div class="dc-wallet" data-wallet-b><span class="dc-glyph">&#128091;</span><span class="dc-lbl">Wallet</span></div>
      </div>
      <div class="dc-chip" data-chip><code>zswapoffer1…</code></div>
    </div>
    <div class="dc-readout-wrap">
      <div class="dc-readout-sizer" aria-hidden="true">${STEPS.map((s) => `<p>${s}</p>`).join("")}</div>
      <p class="dc-readout" data-readout>Paste an offer into Discord and a friend can take it &mdash; no escrow needed.</p>
    </div>`;

  const caption = figure.querySelector("figcaption");
  figure.insertBefore(stage, caption);
  figure.classList.add("dc-enhanced");

  const q = <T extends Element>(s: string) => stage.querySelector(s) as T;
  const stageEl = q<HTMLElement>("[data-stage]");
  const chip = q<HTMLElement>("[data-chip]");
  const readout = q<HTMLElement>("[data-readout]");
  const channel = q<HTMLElement>("[data-channel]");
  const userA = q<HTMLElement>("[data-user-a]");
  const userB = q<HTMLElement>("[data-user-b]");
  const walletA = q<HTMLElement>("[data-wallet-a]");
  const walletB = q<HTMLElement>("[data-wallet-b]");
  const fillL = q<HTMLElement>("[data-fill-l]");
  const fillR = q<HTMLElement>("[data-fill-r]");

  let tl: gsap.core.Timeline | null = null;

  // Translate (x,y) that lands the chip's centre on `el`'s centre. The chip is
  // anchored at the stage's top-left (left:0;top:0), so we offset by the chip's
  // own (untransformed) size; offsetWidth/Height ignore any scale transform.
  const centerIn = (el: HTMLElement): { x: number; y: number } => {
    const sr = stageEl.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    return {
      x: er.left + er.width / 2 - sr.left - chip.offsetWidth / 2,
      y: er.top + er.height / 2 - sr.top - chip.offsetHeight / 2,
    };
  };
  const lit = (el: HTMLElement, on: boolean) => el.classList.toggle("lit", on);

  // Reset only the VISUAL state — never kills `tl` (that was the old loop bug:
  // resetting inside onRepeat killed the very timeline that was repeating).
  function resetVisuals(): void {
    [userA, userB, walletA, walletB, channel].forEach((el) => lit(el, false));
    fillL.style.width = "0%";
    fillR.style.width = "0%";
    const c = centerIn(walletA);
    gsap.set(chip, { x: c.x, y: c.y, opacity: 0, scale: 0.7 });
  }

  function showFinal(): void {
    [userA, userB, walletA, walletB, channel].forEach((el) => lit(el, true));
    fillL.style.width = "100%";
    fillR.style.width = "100%";
    const c = centerIn(walletB);
    gsap.set(chip, { x: c.x, y: c.y, opacity: 1, scale: 1 });
    readout.innerHTML = STEPS[STEPS.length - 1];
  }

  function buildPass(): gsap.core.Timeline {
    const t = gsap.timeline();
    t.add(() => resetVisuals());

    // Beat 0: A's wallet builds the offer; chip rises to User A (vertical).
    t.add(() => { readout.innerHTML = STEPS[0]; lit(walletA, true); });
    t.fromTo(chip, { opacity: 0, scale: 0.7 }, { opacity: 1, scale: 1, duration: 0.35, ease: "back.out(2.2)" });
    t.add(() => lit(userA, true));
    t.to(chip, { ...centerIn(userA), duration: 0.4, ease: "power1.inOut" });
    t.to({}, { duration: 0.45 });

    // Beat 1: A → the #offers pill (right, along the line); left half fills.
    t.add(() => { readout.innerHTML = STEPS[1]; });
    t.to(fillL, { width: "100%", duration: 0.45, ease: "none" }, "<");
    t.to(chip, { ...centerIn(channel), duration: 0.55, ease: "power1.inOut" }, "<");
    t.add(() => lit(channel, true));
    t.fromTo(channel, { scale: 1 }, { scale: 1.12, duration: 0.22, yoyo: true, repeat: 1, ease: "power1.inOut" });
    t.to({}, { duration: 0.45 });

    // Beat 2: pill → User B (right, along the line); right half fills.
    t.add(() => { readout.innerHTML = STEPS[2]; lit(userB, true); });
    t.to(fillR, { width: "100%", duration: 0.45, ease: "none" }, "<");
    t.to(chip, { ...centerIn(userB), duration: 0.55, ease: "power1.inOut" }, "<");
    t.to({}, { duration: 0.45 });

    // Beat 3: B drops it into their wallet (vertical) and it settles.
    t.add(() => { readout.innerHTML = STEPS[3]; });
    t.to(chip, { ...centerIn(walletB), duration: 0.4, ease: "power1.inOut" });
    t.add(() => lit(walletB, true));
    t.fromTo(walletB, { scale: 1 }, { scale: 1.08, duration: 0.22, yoyo: true, repeat: 1, ease: "power1.inOut" });
    t.to({}, { duration: 1.0 }); // hold before the loop restarts
    return t;
  }

  function play(): void {
    if (reduced) { showFinal(); return; }
    tl?.kill();
    const master = gsap.timeline({ repeat: -1, repeatDelay: 0.6 });
    tl = master;
    master.add(buildPass());
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.disconnect(); play(); }
  }, { threshold: 0.3 });
  io.observe(figure);

  let active = figure.classList.contains("narration-active");
  const mo = new MutationObserver(() => {
    const now = figure.classList.contains("narration-active");
    if (now && !active && !reduced) play();
    active = now;
  });
  mo.observe(figure, { attributes: true, attributeFilter: ["class"] });

  if (reduced) showFinal();
  else resetVisuals();
}

// Run-guard LAST: the const-arrow helpers above aren't hoisted.
const fig = document.getElementById("discord-figure");
if (fig) { try { initFigure(fig); } catch (e) { console.error("discordFlow figure failed", e); } }
