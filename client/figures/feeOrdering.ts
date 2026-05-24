// Interactive figure for posts/offer-files.html (Open question #2): how should
// the L2 price and order transactions? There's no clean answer — every knob
// trades one problem for another.
//
// Two controls — a per-transaction FEE slider and an ORDERING toggle (first-come
// vs fee-priority) — drive a verdict checklist over the three coupled pressures:
//   • MEV / fair ordering   (fee-priority → an MEV auction; FIFO avoids on-chain bidding)
//   • market-maker economics (high fees bleed makers, who re-quote constantly)
//   • spam / state growth     (free txs spam the nullifier set — callback to #1)
//
// The catch the figure surfaces: the one all-green corner (low flat fee + FIFO)
// still leans on TRUSTING the BFT committee not to take off-chain reorder bribes,
// and a flat fee can't mirror an exchange's maker/taker rebates. So "solved" is
// really "solved if you trust the committee + accept a blunt fee."
//
// External module for the CSP reason in hashAvalanche.ts. GSAP writes CSSOM
// only. Progressive enhancement over a static SVG; narration-synced; reduced
// motion aware.
import { gsap } from "gsap";

const fig = document.getElementById("fee-figure");
if (fig) initFee(fig);

function initFee(figure: HTMLElement): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const stage = document.createElement("div");
  stage.className = "fo-fig";
  stage.innerHTML = `
    <div class="fo-controls">
      <label class="fo-fee">per-tx fee <input type="range" data-fee min="0" max="100" value="18" aria-label="per-transaction fee" /> <b data-fee-label></b></label>
      <span class="fo-order">ordering:
        <button type="button" data-order="fifo" aria-pressed="true">first-come</button>
        <button type="button" data-order="priority">fee priority</button>
      </span>
    </div>
    <ul class="fo-checks" data-checks></ul>
    <p class="fo-readout" data-readout></p>`;
  const caption = figure.querySelector("figcaption");
  figure.insertBefore(stage, caption);
  figure.classList.add("fee-enhanced");

  const q = <T extends Element>(s: string) => stage.querySelector(s) as T;
  const fee = q<HTMLInputElement>("[data-fee]");
  const feeLabel = q<HTMLElement>("[data-fee-label]");
  const checks = q<HTMLElement>("[data-checks]");
  const readout = q<HTMLElement>("[data-readout]");
  const orderBtns = Array.from(stage.querySelectorAll<HTMLButtonElement>("[data-order]"));

  let order: "fifo" | "priority" = "fifo";

  function render(animate: boolean): void {
    const v = Number(fee.value);
    // Only three regimes matter to the tradeoffs: free (spam), low (the best
    // corner), and high (prices out makers). "moderate" behaved identically to
    // "high", so it's merged in.
    const label = v === 0 ? "free" : v <= 33 ? "low" : "high";
    feeLabel.textContent = label;
    orderBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.order === order)));

    const makersOk = v <= 33;
    const spamOk = v > 0;

    // Ordering is never a clean win: fee-priority is an MEV auction (bad), and even
    // first-come is only fair ON-chain — it pushes the bribery off-chain, which only
    // a trusted committee stops (warn, not ok).
    const ordering =
      order === "fifo"
        ? { state: "warn", text: "Fair in theory &mdash; but first-come invites <em>off-chain</em> deals to jump the queue" }
        : { state: "bad", text: "MEV: highest fee wins the slot &mdash; an on-chain bidding auction" };

    const rows = [
      ordering,
      makersOk
        ? { state: "ok", text: "Market makers can cancel &amp; re-quote cheaply" }
        : { state: "bad", text: "Fees bleed market makers, who re-quote constantly" },
      spamOk
        ? { state: "ok", text: "Spam costs something &mdash; the nullifier set stays sane" }
        : { state: "bad", text: "Free txs invite spam &mdash; nullifier set explodes, proofs slow" },
    ];
    const icon = (s: string) => (s === "ok" ? "✓" : s === "warn" ? "⚠" : "✗");
    checks.innerHTML = rows.map((r) => `<li class="${r.state}">${icon(r.state)} ${r.text}</li>`).join("");

    // The "best" corner: no hard ✗, with ordering left as the amber caveat.
    const bestCorner = makersOk && spamOk && order === "fifo";
    figure.classList.toggle("fo-caveat", bestCorner);
    if (bestCorner) {
      readout.innerHTML =
        "About as good as it gets &mdash; a <b>low flat fee</b> lets makers re-quote and still costs spammers something. But ordering is the catch (amber above): first-come is only fair <em>on-chain</em>; off-chain, someone can still pay a block producer to reorder, and the only thing preventing that is picking a BFT committee you trust. A flat fee also can't mirror an exchange's maker/taker rebates. No clean, trustless answer yet.";
    } else {
      const probs: string[] = [];
      if (!spamOk) probs.push("free transactions invite spam that balloons the nullifier set");
      if (!makersOk) probs.push("the fee bleeds market makers who re-quote constantly");
      if (order === "priority") probs.push("fee-priority ordering turns the next slot into an MEV auction");
      readout.innerHTML = `This setting still has a problem: ${probs.join("; ")}. Fix it and a <em>different</em> pressure opens up &mdash; that's the dilemma.`;
    }
    if (animate && !reduced) gsap.fromTo(checks, { opacity: 0.4 }, { opacity: 1, duration: 0.25, ease: "power1.out" });
  }

  fee.addEventListener("input", () => render(true));
  orderBtns.forEach((b) => b.addEventListener("click", () => { order = b.dataset.order as "fifo" | "priority"; render(true); }));
  render(false);

  function intro(): void {
    if (reduced) return;
    gsap.from(stage.querySelectorAll(".fo-checks li"), { opacity: 0, y: 6, duration: 0.3, stagger: 0.06, ease: "power1.out" });
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
