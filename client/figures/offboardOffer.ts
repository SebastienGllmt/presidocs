// Interactive figure for posts/offer-files.html: offboarding (L2 → L1 withdrawal)
// as an offer file split across two layers.
//
// On the L2 you have a third move beyond create/cancel: OFFBOARD — an unbalanced
// swap that locks the funds you want out and makes them unspendable on the L2.
// That offboard is part of the L2 state, so it rides inside the one recursive
// proof posted to the L1; the L1 contract then pays the funds to the SAME
// address that locked them. Same address on both sides is the whole security.
//
// The reader toggles "claim as" between their own address (✓ released) and a
// stranger's (✗ blocked) to feel why the shared address prevents theft.
//
// External module for the CSP reason in hashAvalanche.ts. GSAP writes CSSOM
// only. Progressive enhancement over a static SVG; narration-synced; reduced
// motion aware.
import { gsap } from "gsap";

const SELF = "0x9f…a1";
const OTHER = "0x33…ff";

const fig = document.getElementById("offboard-figure");
if (fig) initOffboard(fig);

function initOffboard(figure: HTMLElement): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const stage = document.createElement("div");
  stage.className = "ob-fig";
  stage.innerHTML = `
    <div class="ob-cap">offboarding = one offer file, split across two layers</div>
    <div class="ob-lane l2">
      <span class="ob-tag">L2</span>
      <div class="ob-card">
        <div class="ob-card-t">offboard offer &mdash; lock</div>
        <div class="ob-card-b">Lock <b>5 🌙 NIGHT</b>, now <b>unspendable on the L2</b><br /><small>an unbalanced swap: funds leave, nothing comes back</small></div>
        <div class="ob-addr">locked by <code>${SELF}</code></div>
      </div>
    </div>
    <div class="ob-bridge">
      <span class="ob-proof">&darr; carried inside the one recursive proof &rarr; posted to the L1</span>
      <span class="ob-link" data-link></span>
    </div>
    <div class="ob-lane l1">
      <span class="ob-tag">L1</span>
      <div class="ob-card" data-l1>
        <div class="ob-card-t">L1 payout</div>
        <div class="ob-card-b" data-l1body></div>
        <div class="ob-claim">claim as:
          <button type="button" data-claim="self" aria-pressed="true">${SELF} (you)</button>
          <button type="button" data-claim="other">${OTHER} (someone else)</button>
        </div>
      </div>
    </div>
    <p class="ob-readout" data-readout></p>`;
  const caption = figure.querySelector("figcaption");
  figure.insertBefore(stage, caption);
  figure.classList.add("offboard-enhanced");

  const q = <T extends Element>(s: string) => stage.querySelector(s) as T;
  const l1 = q<HTMLElement>("[data-l1]");
  const l1body = q<HTMLElement>("[data-l1body]");
  const link = q<HTMLElement>("[data-link]");
  const readout = q<HTMLElement>("[data-readout]");
  const claimBtns = Array.from(stage.querySelectorAll<HTMLButtonElement>("[data-claim]"));

  let claim: "self" | "other" = "self";

  function render(animate: boolean): void {
    claimBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.claim === claim)));
    const match = claim === "self";
    figure.classList.toggle("ob-ok", match);
    figure.classList.toggle("ob-blocked", !match);
    link.innerHTML = match
      ? `&#128279; same address on both sides &mdash; <code>${SELF}</code>`
      : `&#9888; address mismatch &mdash; <code>${OTHER}</code> &ne; <code>${SELF}</code>`;
    l1body.innerHTML = match
      ? `&check; Release <b>5 🌙 NIGHT</b> to <code>${SELF}</code>`
      : `&times; Blocked &mdash; funds only release to the address that locked them`;
    readout.innerHTML = match
      ? `Offboarding is just an <b>offer file across two layers</b>: the L2 half locks your funds; the L1 half pays them out. Because the offboard sits inside the recursive proof, the L1 contract honors it &mdash; releasing the funds to the <b>same address</b> that locked them. Try claiming as someone else.`
      : `Blocked. The L1 only pays the <b>address that locked the funds on the L2</b>. That single rule &mdash; same address on both sides &mdash; is what stops anyone from intercepting your exit.`;
    if (animate && !reduced) {
      gsap.fromTo(l1, { scale: 0.96 }, { scale: 1, duration: 0.3, ease: "back.out(2)" });
    }
  }

  claimBtns.forEach((b) => b.addEventListener("click", () => { claim = b.dataset.claim as "self" | "other"; render(true); }));
  render(false);

  function intro(): void {
    if (reduced) return;
    gsap.from(stage.querySelectorAll(".ob-lane, .ob-bridge"), { opacity: 0, y: 8, duration: 0.35, stagger: 0.12, ease: "power1.out" });
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.disconnect(); intro(); }
  }, { threshold: 0.3 });
  io.observe(figure);

  let active = figure.classList.contains("narration-active");
  const mo = new MutationObserver(() => {
    const now = figure.classList.contains("narration-active");
    if (now && !active) intro();
    active = now;
  });
  mo.observe(figure, { attributes: true, attributeFilter: ["class"] });
}
