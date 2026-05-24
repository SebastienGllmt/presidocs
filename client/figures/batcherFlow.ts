// Animated "the batcher pays the fee" figure for the batcher post.
//
// A left→right flow of three nodes: a Midnight user (no TIA), the batcher
// (holds TIA, pays the fee), and Celestia (the public bulletin board). A packet
// carrying the user's offer travels user → batcher; at the batcher a "+ TIA
// fee" tag attaches (the batcher is paying); the packet then travels batcher →
// Celestia and lands as "posted ✓". Takeaway: the user never needs Celestia's
// token — they hand the offer to the batcher, which submits the blob and pays
// the TIA fee on their behalf.
//
// External module for the same CSP reason as the other figures (see
// client/figures/hashAvalanche.ts). GSAP only writes CSSOM. Enhancement
// contract is identical: static SVG fallback, `.bat-enhanced`,
// IntersectionObserver intro, `narration-active` replay, reduced-motion aware.
import { gsap } from "gsap";

interface Node {
  icon: string;
  title: string;
  note: string;
}

const NODES: Node[] = [
  { icon: "👤", title: "User", note: "holds Midnight assets &middot; no TIA" },
  { icon: "🧰", title: "Batcher", note: "holds TIA &middot; pays the fee" },
  { icon: "🟪", title: "Celestia", note: "public bulletin board" },
];

const INTRO =
  "The user hands their offer to the batcher — they never touch Celestia's token. Press play, or just listen.";
const DONE =
  "The user never needs TIA: they just hand the offer to the batcher, which posts the blob to Celestia and pays the TIA fee on their behalf.";

const initFigure = (figure: HTMLElement): void => {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const stage = document.createElement("div");
  stage.className = "bat-fig";

  const parts: string[] = ['<div class="flow">'];
  NODES.forEach((n, i) => {
    if (i > 0) parts.push('<div class="link"><span class="link-fill"></span></div>');
    parts.push(
      `<div class="node" data-node="${i}">
         <div class="icon">${n.icon}</div>
         <div class="n-title">${n.title}</div>
         <div class="n-note">${n.note}</div>
       </div>`,
    );
  });
  parts.push("</div>");
  parts.push(
    `<div class="track" data-track>
       <span class="packet" data-packet>offer</span>
       <span class="fee-tag" data-fee>+ TIA fee</span>
       <span class="posted" data-posted>posted &check;</span>
     </div>`,
  );
  parts.push(
    `<div class="controls">
       <button type="button" class="replay" data-replay>&#9654; Play the flow</button>
       <div class="cap-wrap">
         <p class="step-caption-sizer" aria-hidden="true">${DONE}</p>
         <p class="step-caption" data-caption>${INTRO}</p>
       </div>
     </div>`,
  );
  stage.innerHTML = parts.join("");

  const caption = figure.querySelector("figcaption");
  figure.insertBefore(stage, caption);
  figure.classList.add("bat-enhanced");

  const nodeEls = Array.from(stage.querySelectorAll<HTMLElement>(".node"));
  const linkFills = Array.from(stage.querySelectorAll<HTMLElement>(".link-fill"));
  const captionEl = stage.querySelector<HTMLElement>("[data-caption]")!;
  const replayBtn = stage.querySelector<HTMLButtonElement>("[data-replay]")!;
  const packet = stage.querySelector<HTMLElement>("[data-packet]")!;
  const feeTag = stage.querySelector<HTMLElement>("[data-fee]")!;
  const posted = stage.querySelector<HTMLElement>("[data-posted]")!;

  let tl: gsap.core.Timeline | null = null;
  let loopTimer: gsap.core.Tween | null = null;

  // x-translate that puts `ref`'s center under `el`'s center. Transform-aware:
  // it adds back `ref`'s current translate so the result is correct even on a
  // replay where ref still carries an `x` from the previous run (the old bug:
  // the labels drifted because their leftover transform wasn't accounted for).
  const centerX = (el: HTMLElement, ref: HTMLElement): number => {
    const r = el.getBoundingClientRect();
    const rr = ref.getBoundingClientRect();
    const curX = Number(gsap.getProperty(ref, "x")) || 0;
    return r.left + r.width / 2 - (rr.left + rr.width / 2) + curX;
  };

  const reset = (): void => {
    tl?.kill();
    loopTimer?.kill();
    loopTimer = null;
    nodeEls.forEach((el) => el.classList.remove("lit"));
    linkFills.forEach((el) => { el.style.width = "0%"; });
    // Zero every label's transform so build-time centerX measurements start clean.
    gsap.set(packet, { x: 0, y: 0, opacity: 0, scale: 1 });
    gsap.set(feeTag, { x: 0, opacity: 0, scale: 0.6, y: 0 });
    gsap.set(posted, { x: 0, opacity: 0, scale: 0.6 });
  };

  const lightAll = (): void => {
    nodeEls.forEach((el) => el.classList.add("lit"));
    linkFills.forEach((el) => { el.style.width = "100%"; });
    gsap.set(packet, { opacity: 0 });
    gsap.set(feeTag, { opacity: 0 });
    gsap.set(posted, { opacity: 1, scale: 1, x: centerX(nodeEls[2], posted) });
    captionEl.innerHTML = DONE;
  };

  const play = (): void => {
    if (reduced) { reset(); lightAll(); return; }
    reset();
    // Auto-loop a few seconds after the flow lands on Celestia.
    const t = gsap.timeline({ onComplete: () => { loopTimer = gsap.delayedCall(3, play); } });
    tl = t;

    // 1. User lights up, packet appears at the user.
    t.add(() => { captionEl.innerHTML = NODES[0].note + " &mdash; building an offer."; });
    t.fromTo(nodeEls[0], { scale: 0.92 }, {
      scale: 1, duration: 0.35, ease: "back.out(2.4)",
      onStart() { nodeEls[0].classList.add("lit"); },
    });
    t.set(packet, { x: centerX(nodeEls[0], packet), opacity: 0, scale: 0.7 });
    t.to(packet, { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(2)" });

    // 2. Packet travels user → batcher; connector fills.
    t.add(() => { captionEl.innerHTML = "The user hands the offer to the batcher."; });
    t.to(linkFills[0], { width: "100%", duration: 0.4, ease: "none" }, "<");
    t.to(packet, { x: centerX(nodeEls[1], packet), duration: 0.6, ease: "power1.inOut" }, "<");
    t.add(() => { nodeEls[1].classList.add("lit"); });

    // 3. Batcher attaches the TIA fee (it is paying).
    t.add(() => { captionEl.innerHTML = "The batcher attaches the <b>TIA fee</b> &mdash; it pays, not the user."; });
    t.set(feeTag, { x: centerX(nodeEls[1], feeTag) });
    t.fromTo(feeTag, { opacity: 0, scale: 0.6, y: 6 }, {
      opacity: 1, scale: 1, y: 0, duration: 0.4, ease: "back.out(2.5)",
    });
    t.to({}, { duration: 0.45 }); // dwell

    // 4. Packet (with fee) travels batcher → Celestia; connector fills.
    t.add(() => { captionEl.innerHTML = "The batcher posts the blob to Celestia."; });
    t.to(linkFills[1], { width: "100%", duration: 0.4, ease: "none" }, "<");
    t.to([packet, feeTag], { x: centerX(nodeEls[2], packet), duration: 0.6, ease: "power1.inOut" }, "<");
    t.add(() => { nodeEls[2].classList.add("lit"); });

    // 5. Lands on Celestia: posted ✓.
    t.to([packet, feeTag], { opacity: 0, scale: 0.7, duration: 0.25, ease: "power2.in" });
    t.set(posted, { x: centerX(nodeEls[2], posted) });
    t.fromTo(posted, { opacity: 0, scale: 0.6 }, {
      opacity: 1, scale: 1, duration: 0.45, ease: "back.out(2.6)",
    });
    t.add(() => { captionEl.innerHTML = DONE; });
  };

  replayBtn.addEventListener("click", play);
  reset();

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
};

const fig = document.getElementById("batcher-figure");
if (fig) { try { initFigure(fig); } catch (e) { console.error("batcherFlow figure failed", e); } }
