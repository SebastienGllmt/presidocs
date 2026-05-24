// Interactive figure for posts/offer-files.html: the "one proof for everyone"
// solution to the private-balance-proving problem.
//
// Instead of every user proving their own balance (infeasible — each proof must
// sweep the whole history), the sequencer proves ONCE for all users. Users send
// their viewing keys into the sequencer's TEE; a single recursive SNARK runs
// inside the enclave, where it can read every balance, and folds the entire swap
// history exactly once into a single succinct proof + a balances commitment.
//
// The two assumptions are deliberately split, and the figure makes that the
// point: INTEGRITY is cryptographic (the SNARK — unforgeable even if the TEE
// breaks), the TEE only provides PRIVACY (it hides the viewing keys/balances).
// A users slider shows the work going from N×(history) to 1×(history).
//
// External module for the CSP reason in hashAvalanche.ts. GSAP writes CSSOM
// only. Progressive enhancement over a static SVG; narration-synced; reduced
// motion aware.
import { gsap } from "gsap";

const fig = document.getElementById("sequencer-proof-figure");
if (fig) initSeqProof(fig);

function initSeqProof(figure: HTMLElement): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
  // log-scale slider 0..100 → 10..10,000 users
  const usersFor = (v: number) => Math.round(10 * Math.pow(1000, v / 100));

  const stage = document.createElement("div");
  stage.className = "sp-fig";
  stage.innerHTML = `
    <div class="sp-stage">
      <div class="sp-users">
        <div class="sp-col-label">L2 users</div>
        <div class="sp-avatars" data-avatars></div>
      </div>
      <div class="sp-flow">keys&nbsp;&rarr;</div>
      <div class="sp-tee" data-tee>
        <div class="sp-tee-cap">&#128274; sequencer TEE</div>
        <div class="sp-snark">recursive SNARK<br /><small>folds every swap once &middot; sees all balances</small></div>
        <div class="sp-tee-note">viewing keys sealed inside &mdash; the operator can't read them</div>
      </div>
      <div class="sp-flow">&rarr;</div>
      <div class="sp-out" data-out>
        <div class="sp-out-head">posted to the L1</div>
        <div class="sp-proof">1 succinct proof</div>
        <div class="sp-plus">attests &darr;</div>
        <div class="sp-commit">balances commitment</div>
        <div class="sp-out-note">the proof attests the commitment; each user opens their own slice of it to withdraw, balances stay hidden</div>
      </div>
    </div>
    <div class="sp-controls">
      <label>L2 users <input type="range" data-users min="0" max="100" value="57" aria-label="number of L2 users" /> <b data-users-label></b></label>
    </div>
    <div class="sp-compare">
      <div class="sp-row alone">
        <span class="sp-row-label">everyone proves alone</span>
        <span class="sp-bar"><span class="fill" data-alone></span></span>
        <span class="sp-row-val" data-alone-val></span>
      </div>
      <div class="sp-row batched">
        <span class="sp-row-label">TEE proves once</span>
        <span class="sp-bar"><span class="fill" data-batched></span></span>
        <span class="sp-row-val">1 proof &check;</span>
      </div>
    </div>
    <p class="sp-readout" data-readout></p>`;
  const caption = figure.querySelector("figcaption");
  figure.insertBefore(stage, caption);
  figure.classList.add("seqproof-enhanced");

  const q = <T extends Element>(s: string) => stage.querySelector(s) as T;
  const avatars = q<HTMLElement>("[data-avatars]");
  const slider = q<HTMLInputElement>("[data-users]");
  const usersLabel = q<HTMLElement>("[data-users-label]");
  const aloneFill = q<HTMLElement>("[data-alone]");
  const batchedFill = q<HTMLElement>("[data-batched]");
  const aloneVal = q<HTMLElement>("[data-alone-val]");
  const readout = q<HTMLElement>("[data-readout]");
  const tee = q<HTMLElement>("[data-tee]");

  // A fixed set of avatar+key chips (visual stand-ins for the N users).
  const KEYS = 10;
  const keyEls: HTMLElement[] = [];
  for (let i = 0; i < KEYS; i++) {
    const a = document.createElement("div");
    a.className = "sp-avatar";
    a.innerHTML = `<span class="sp-face">&#128100;</span><span class="sp-key" data-key>&#128273;</span>`;
    avatars.appendChild(a);
    keyEls.push(a.querySelector("[data-key]") as HTMLElement);
  }

  function update(): void {
    const N = usersFor(Number(slider.value));
    usersLabel.textContent = fmt(N);
    // "alone" total work grows with N (log-scaled bar so it reads across the range);
    // "batched" is always one pass.
    const aloneW = Math.min(100, (Math.log10(N) / 4) * 100);
    aloneFill.style.width = `${aloneW}%`;
    batchedFill.style.width = "3%";
    aloneVal.innerHTML = `${fmt(N)} proofs &times;`;
    readout.innerHTML =
      `With <b>${fmt(N)}</b> users, proving each balance separately means <b>${fmt(N)} proofs</b>, each re-sweeping the entire history &mdash; hopeless. ` +
      `Batched in the TEE it's <b>one</b> proof for everyone: the whole-history scan happens once, not ${fmt(N)} times. ` +
      `Integrity is the proof itself; the TEE only keeps the keys private.`;
  }

  slider.addEventListener("input", update);
  update();

  function play(): void {
    if (reduced) return;
    // keys fly into the TEE, then a single proof pops out
    const teeRect = tee.getBoundingClientRect();
    const tl = gsap.timeline();
    keyEls.forEach((k, i) => {
      const kr = k.getBoundingClientRect();
      tl.to(k, {
        x: teeRect.left + teeRect.width / 2 - (kr.left + kr.width / 2),
        y: teeRect.top + teeRect.height / 2 - (kr.top + kr.height / 2),
        opacity: 0, scale: 0.6, duration: 0.5, ease: "power2.in",
      }, i * 0.05);
    });
    tl.fromTo(tee, { boxShadow: "0 0 0 rgba(106,79,176,0)" }, { boxShadow: "0 0 18px rgba(106,79,176,0.5)", duration: 0.25, yoyo: true, repeat: 1 }, ">-0.1");
    tl.fromTo(q<HTMLElement>("[data-out]"), { scale: 0.7, opacity: 0.3 }, { scale: 1, opacity: 1, duration: 0.45, ease: "back.out(2.5)" });
    tl.add(() => keyEls.forEach((k) => gsap.set(k, { x: 0, y: 0, opacity: 1, scale: 1 })), "+=0.6");
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.disconnect(); play(); }
  }, { threshold: 0.3 });
  io.observe(figure);

  let active = figure.classList.contains("narration-active");
  const mo = new MutationObserver(() => {
    const now = figure.classList.contains("narration-active");
    if (now && !active) play();
    active = now;
  });
  mo.observe(figure, { attributes: true, attributeFilter: ["class"] });
}
