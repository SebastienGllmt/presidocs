// Interactive figure for posts/offer-files.html: why an offer is free to make
// but costly to cancel — and why ONE coin backs MANY copies of the offer.
//
// A zSwap offer is built from a specific coin — a UTXO. The maker proves it once
// and gets a single `zswapoffer1…` file, which then fans out to many places. Every
// one of those copies is the SAME offer backed by the SAME single coin. So:
//   • Create & share  → off-chain, free (one file, copied freely to many places)
//   • A taker fills it → on-chain (settlement spends the coin)
//   • Cancel it        → ALSO on-chain (the only way to void every copy that's
//                         already out there is to spend the coin yourself)
// Because every copy is tethered to that one UTXO, spending it (via fill or cancel)
// cascades to invalidate ALL copies at once — there is no off-chain "unsend". The
// reader drives the lifecycle, sees the shared backing drawn as link lines, watches
// the cascade kill every copy, and tracks the on-chain transaction counter — making
// the create-free / fill-or-cancel-costly asymmetry concrete.
//
// External module for the CSP reason documented in hashAvalanche.ts. GSAP only
// writes CSSOM. Progressive enhancement over a static SVG; narration-synced
// replay; reduced-motion aware.
import { gsap } from "gsap";

type Phase = "none" | "open" | "filled" | "cancelled";

const COPIES = ["on Celestia", "in a Discord DM", "on a DEX frontend", "in a friend's wallet"];

const initUtxoFigure = (figure: HTMLElement): void => {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const stage = document.createElement("div");
  stage.className = "utxo-fig";
  stage.innerHTML = `
    <div class="legend">
      <span class="k offchain">off-chain &middot; free &amp; instant</span>
      <span class="k onchain">on-chain &middot; costs a transaction</span>
    </div>
    <div class="utxo-stage" data-stage>
      <svg class="tethers" data-tethers preserveAspectRatio="none" aria-hidden="true"></svg>
      <div class="coin-col">
        <div class="coin" data-coin>
          <div class="coin-cap">maker's coin <span class="utxo-tag">a UTXO</span></div>
          <div class="coin-amt">5 🌙 NIGHT</div>
          <div class="coin-state" data-coin-state>unspent</div>
        </div>
      </div>
      <div class="conn"><span class="conn-lbl">proves</span><span class="conn-arr">&rarr;</span></div>
      <div class="file-col">
        <div class="offer-file" data-file>
          <div class="file-cap">one offer file</div>
          <div class="file-tag">zswapoffer1…</div>
        </div>
        <div class="file-empty" data-file-empty>no offer yet</div>
      </div>
      <div class="conn" data-conn-b><span class="conn-lbl">posted to</span><span class="conn-arr">&rarr;</span></div>
      <div class="copies-col">
        <div class="copies" data-copies></div>
        <div class="copies-empty" data-copies-empty>nowhere yet</div>
      </div>
    </div>
    <div class="actions">
      <button type="button" data-act="create">Create &amp; share offer</button>
      <button type="button" data-act="fill">A taker fills it</button>
      <button type="button" data-act="cancel">Cancel the offer</button>
      <button type="button" data-act="reset" class="ghost">Reset</button>
    </div>
    <div class="txbar">on-chain transactions so far: <b data-tx>0</b></div>
    <p class="readout" data-readout>One coin proves <b>one</b> offer file, which gets copied to <b>many</b> places. Press <b>Create &amp; share</b> &mdash; that part is free.</p>`;
  const caption = figure.querySelector("figcaption");
  figure.insertBefore(stage, caption);
  figure.classList.add("utxo-enhanced");

  const q = <T extends Element>(s: string) => stage.querySelector(s) as T;
  const stageEl = q<HTMLElement>("[data-stage]");
  const tethers = q<SVGSVGElement>("[data-tethers]");
  const connB = q<HTMLElement>("[data-conn-b]");
  const coin = q<HTMLElement>("[data-coin]");
  const coinState = q<HTMLElement>("[data-coin-state]");
  const file = q<HTMLElement>("[data-file]");
  const fileEmpty = q<HTMLElement>("[data-file-empty]");
  const copiesBox = q<HTMLElement>("[data-copies]");
  const copiesEmpty = q<HTMLElement>("[data-copies-empty]");
  const txEl = q<HTMLElement>("[data-tx]");
  const readout = q<HTMLElement>("[data-readout]");
  const btn = (a: string) => q<HTMLButtonElement>(`[data-act="${a}"]`);

  let phase: Phase = "none";
  let txCount = 0;

  // Fan an SVG link line out of the "posted to →" connector to every copy, so
  // the one-file-to-many-copies fan-out is unmistakable. The lines start just
  // left of the copies (at the connector's tip) and never cross the file box.
  const drawTethers = (): void => {
    while (tethers.firstChild) tethers.removeChild(tethers.firstChild);
    const copies = Array.from(copiesBox.querySelectorAll<HTMLElement>(".copy"));
    if (phase === "none" || copies.length === 0) return;
    const sb = stageEl.getBoundingClientRect();
    tethers.setAttribute("viewBox", `0 0 ${sb.width} ${sb.height}`);
    const ob = connB.getBoundingClientRect();
    const x1 = ob.right - sb.left;
    const y1 = ob.top + ob.height / 2 - sb.top;
    for (const cp of copies) {
      const rb = cp.getBoundingClientRect();
      const x2 = rb.left - sb.left;
      const y2 = rb.top + rb.height / 2 - sb.top;
      const mx = (x1 + x2) / 2;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", "tether");
      path.setAttribute("d", `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
      tethers.appendChild(path);
    }
  };

  const renderCopies = (): void => {
    copiesBox.innerHTML = "";
    if (phase === "none") return;
    COPIES.forEach((label) => {
      const c = document.createElement("div");
      c.className = "copy";
      c.innerHTML = `<span class="copy-tag">zswapoffer1…</span><span class="copy-where">${label}</span><span class="copy-status" data-copy-status>live</span>`;
      copiesBox.appendChild(c);
    });
    drawTethers();
    if (!reduced) {
      gsap.from(copiesBox.querySelectorAll(".copy"), { opacity: 0, x: -14, scale: 0.8, stagger: 0.07, duration: 0.32, ease: "back.out(2)" });
      gsap.from(tethers.querySelectorAll(".tether"), { opacity: 0, duration: 0.4, delay: 0.1, stagger: 0.07 });
    }
  };

  const flashTx = (): void => {
    txCount++;
    txEl.textContent = String(txCount);
    if (reduced) return;
    const stamp = document.createElement("div");
    stamp.className = "tx-stamp";
    stamp.textContent = "⛓ on-chain tx";
    stageEl.appendChild(stamp);
    gsap.fromTo(stamp, { opacity: 0, scale: 0.5, y: 0 }, { opacity: 1, scale: 1, duration: 0.25, ease: "back.out(3)" });
    gsap.to(stamp, { opacity: 0, y: -34, duration: 0.7, delay: 0.7, ease: "power1.in", onComplete: () => stamp.remove() });
  };

  const setCoinSpent = (): void => {
    coin.classList.add("spent");
    coinState.textContent = "spent";
  };

  // Spending the one coin cascades: the file dies, then every copy dies in turn,
  // staggered left-to-right, driving home that consuming the UTXO kills them all.
  const cascadeKill = (mode: "filled" | "cancelled"): void => {
    file.classList.add("void");
    const copies = Array.from(copiesBox.querySelectorAll<HTMLElement>(".copy"));
    const word = mode === "filled" ? "dead" : "void";
    const apply = (cp: HTMLElement) => {
      cp.classList.add("void");
      const s = cp.querySelector<HTMLElement>("[data-copy-status]");
      if (s) s.textContent = word;
    };
    if (reduced) {
      file.querySelector<HTMLElement>(".file-tag")?.classList.add("strike");
      copies.forEach(apply);
      const paths = tethers.querySelectorAll<SVGElement>(".tether");
      paths.forEach((p) => p.classList.add("dead"));
      return;
    }
    const tl = gsap.timeline();
    // The coin grays out first, then the kill ripples outward to the file and copies.
    tl.to(file.querySelector(".file-tag"), { opacity: 0.4, duration: 0.25, onStart: () => file.querySelector(".file-tag")?.classList.add("strike") });
    const paths = Array.from(tethers.querySelectorAll<SVGElement>(".tether"));
    copies.forEach((cp, i) => {
      tl.add(() => {
        apply(cp);
        paths[i]?.classList.add("dead");
      }, i === 0 ? ">" : "<+=0.14");
      tl.fromTo(cp, { scale: 1 }, { scale: 0.92, duration: 0.12, yoyo: true, repeat: 1, ease: "power1.inOut" }, "<");
    });
  };

  const render = (): void => {
    figure.classList.toggle("is-open", phase === "open");
    figure.classList.toggle("is-done", phase === "filled" || phase === "cancelled");
    const hasOffer = phase !== "none";
    fileEmpty.style.display = hasOffer ? "none" : "";
    file.style.display = hasOffer ? "" : "none";
    copiesEmpty.style.display = hasOffer ? "none" : "";
    copiesBox.classList.toggle("filled", phase === "filled");
    copiesBox.classList.toggle("void", phase === "filled" || phase === "cancelled");
    btn("create").disabled = phase !== "none";
    btn("fill").disabled = phase !== "open";
    btn("cancel").disabled = phase !== "open";
  };

  const onCreate = (): void => {
    if (phase !== "none") return;
    phase = "open";
    render();
    renderCopies();
    readout.innerHTML = "Created and shared &mdash; <b class='ok'>no transaction</b>. The wallet proved <b>one</b> file and it's now copied to <b>many</b> places. Notice every copy is tethered to the <b>same single coin</b>, so they're all live and fillable at once.";
  };

  const onFill = (): void => {
    if (phase !== "open") return;
    phase = "filled";
    setCoinSpent();
    flashTx();
    render();
    cascadeKill("filled");
    readout.innerHTML = "A taker merged the matching half and <b>settled on-chain</b> &mdash; that <b class='cost'>spent the one coin</b>. Because every copy was backed by it, they <b>all</b> go dead together: one spend cascades through the whole fan-out.";
  };

  const onCancel = (): void => {
    if (phase !== "open") return;
    phase = "cancelled";
    setCoinSpent();
    flashTx();
    render();
    cascadeKill("cancelled");
    readout.innerHTML = "To cancel, the maker has to <b>spend the same coin on-chain</b> themselves. There's no &ldquo;unsend&rdquo; for copies already out there &mdash; consuming the <b>one</b> UTXO is the <b class='cost'>only</b> way to void <b>every</b> copy everywhere. So a cancel costs a transaction too.";
  };

  const onReset = (): void => {
    phase = "none";
    txCount = 0;
    txEl.textContent = "0";
    coin.classList.remove("spent");
    coinState.textContent = "unspent";
    file.classList.remove("void");
    file.querySelector<HTMLElement>(".file-tag")?.classList.remove("strike");
    copiesBox.innerHTML = "";
    while (tethers.firstChild) tethers.removeChild(tethers.firstChild);
    render();
    readout.innerHTML = "One coin proves <b>one</b> offer file, which gets copied to <b>many</b> places. Press <b>Create &amp; share</b> &mdash; that part is free.";
  };

  // Re-draw the tethers whenever the stage's box changes — crucially this fires
  // AFTER the browser lays out the freshly-added copies (the initial draw in
  // renderCopies can run a beat too early, which left only the top line correct
  // until a manual resize nudged a redraw). A ResizeObserver catches that reflow
  // automatically, plus any responsive resize. (It can't loop: drawing tethers
  // only mutates the SVG's children, never the stage's size.)
  const onResize = (): void => { if (phase !== "none") drawTethers(); };
  new ResizeObserver(onResize).observe(stageEl);

  // Narration / scroll triggers just (re)play the create step so a listener
  // sees the offer fan out when the figure is referenced.
  const intro = (): void => {
    if (phase === "none") onCreate();
  };

  btn("create").addEventListener("click", onCreate);
  btn("fill").addEventListener("click", onFill);
  btn("cancel").addEventListener("click", onCancel);
  btn("reset").addEventListener("click", onReset);

  render();

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
};

const fig = document.getElementById("utxo-figure");
if (fig) {
  try {
    initUtxoFigure(fig);
  } catch (err) {
    console.error("utxoSwap figure failed to initialize", err);
  }
}
