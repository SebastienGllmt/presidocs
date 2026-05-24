// Animated "shared liquidity" figure for the presidocs blog.
//
// The point: there is ONE shared pool of offers. Many different producers
// (wallets, DEXes, NFT apps) post offer-files that all FAN IN to a single
// Celestia namespace; many different consumer dApps then FAN OUT from that
// same pool, each just a filter + a frontend over the shared offers. Liquidity
// one app attracts is liquidity every other app can match against.
//
// External module for the same CSP reason as the other figures (see
// client/figures/hashAvalanche.ts). GSAP only writes CSSOM. Enhancement
// contract is identical to offerLifecycle.ts: static SVG fallback,
// `.sl-enhanced`, IntersectionObserver intro (once), `narration-active`
// replay, reduced-motion aware.
import { gsap } from "gsap";

interface Node {
  icon: string;
  label: string;
}

// Producers on the left that emit offer-files into the shared pool.
const SOURCES: Node[] = [
  { icon: "👛", label: "Wallet" },
  { icon: "🔁", label: "DEX A" },
  { icon: "🖼️", label: "NFT app" },
];

// Consumer dApps on the right that read from the same shared pool.
const CONSUMERS: Node[] = [
  { icon: "🔁", label: "DEX" },
  { icon: "🖼️", label: "NFT marketplace" },
  { icon: "📊", label: "Portfolio app" },
  { icon: "🧮", label: "Aggregator" },
];

const buildColumn = (nodes: Node[], side: "src" | "dst"): string => {
  const items = nodes
    .map(
      (n, i) =>
        `<div class="sl-node" data-side="${side}" data-i="${i}">
           <span class="sl-node-icon">${n.icon}</span>
           <span class="sl-node-label">${n.label}</span>
         </div>`,
    )
    .join("");
  return `<div class="sl-col sl-col-${side}">${items}</div>`;
};

const buildMarkup = (): string => {
  return (
    `<div class="sl-diagram">` +
    `<div class="sl-col-cap sl-cap-src">sources</div>` +
    `<div class="sl-col-cap sl-cap-hub">shared pool</div>` +
    `<div class="sl-col-cap sl-cap-dst">apps</div>` +
    buildColumn(SOURCES, "src") +
    `<div class="sl-hub-col">` +
    `<div class="sl-hub" data-hub>` +
    `<span class="sl-hub-icon">🟪</span>` +
    `<span class="sl-hub-name">Celestia</span>` +
    `<span class="sl-hub-sub">one shared pool of offers</span>` +
    `</div>` +
    `</div>` +
    buildColumn(CONSUMERS, "dst") +
    `<div class="sl-chips" data-chips></div>` +
    `</div>` +
    `<div class="sl-controls">` +
    // Reserve a fixed height with a hidden sizer holding the LONGEST caption, so
    // the (absolutely-positioned) active caption never changes the figure's
    // height between steps — no layout shift of the content below.
    `<div class="sl-caption-wrap">` +
    `<p class="sl-caption-sizer" aria-hidden="true">${CAP_FANOUT}</p>` +
    `<p class="sl-caption" data-caption>One pool, many apps.</p>` +
    `</div>` +
    `</div>`
  );
};

const CAP_FANIN = "Every wallet, DEX and NFT app posts its offer-files into the <b>same</b> Celestia namespace.";
const CAP_HUB = "They all collect in one shared pool &mdash; liquidity isn't trapped inside any single app.";
const CAP_FANOUT =
  "Every dApp reads from that same pool. Each one is just a filter and a frontend over the shared offers, so liquidity one app attracts is liquidity <b>every</b> other app can match against.";

const initFigure = (figure: HTMLElement): void => {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const stage = document.createElement("div");
  stage.className = "sl-fig";
  stage.innerHTML = buildMarkup();

  const caption = figure.querySelector("figcaption");
  figure.insertBefore(stage, caption);
  figure.classList.add("sl-enhanced");

  const q = <T extends Element>(s: string) => stage.querySelector(s) as T;
  const hub = q<HTMLElement>("[data-hub]");
  const chipsLayer = q<HTMLElement>("[data-chips]");
  const captionEl = q<HTMLElement>("[data-caption]");
  const srcEls = Array.from(stage.querySelectorAll<HTMLElement>('.sl-node[data-side="src"]'));
  const dstEls = Array.from(stage.querySelectorAll<HTMLElement>('.sl-node[data-side="dst"]'));

  let tl: gsap.core.Timeline | null = null;

  const center = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  const reset = (): void => {
    tl?.kill();
    tl = null;
    chipsLayer.innerHTML = "";
    gsap.set(hub, { scale: 1, boxShadow: "0 0 0 rgba(106,79,176,0)" });
    srcEls.concat(dstEls).forEach((el) => el.classList.remove("lit"));
  };

  // Spawn a chip centered on `from`, animate it to `to`. Used for both the
  // fan-in (source → hub) and fan-out (hub → consumer) phases.
  const flyChip = (
    timeline: gsap.core.Timeline,
    from: HTMLElement,
    to: HTMLElement,
    at: gsap.Position,
    onArrive?: () => void,
  ): void => {
    const a = center(from);
    const b = center(to);
    const stageRect = stage.getBoundingClientRect();
    const chip = document.createElement("div");
    chip.className = "sl-chip";
    chipsLayer.appendChild(chip);
    gsap.set(chip, {
      x: a.x - stageRect.left,
      y: a.y - stageRect.top,
      xPercent: -50,
      yPercent: -50,
      opacity: 0,
      scale: 0.6,
    });
    timeline.to(
      chip,
      {
        x: b.x - stageRect.left,
        y: b.y - stageRect.top,
        opacity: 1,
        scale: 1,
        duration: 0.55,
        ease: "power2.inOut",
        onStart() {
          gsap.to(chip, { opacity: 1, duration: 0.1 });
        },
        onComplete() {
          gsap.to(chip, { opacity: 0, scale: 0.5, duration: 0.25 });
          onArrive?.();
        },
      },
      at,
    );
  };

  const lightAll = (): void => {
    srcEls.concat(dstEls).forEach((el) => el.classList.add("lit"));
    captionEl.innerHTML = CAP_FANOUT;
  };

  const play = (): void => {
    if (reduced) {
      reset();
      lightAll();
      return;
    }
    reset();
    // Auto-loop forever: replay a couple seconds after each pass completes.
    const t = gsap.timeline({ onComplete: () => { gsap.delayedCall(2, play); } });
    tl = t;

    // Phase 1: fan-in. Each source emits a chip that converges on the hub.
    t.add(() => {
      captionEl.innerHTML = CAP_FANIN;
    });
    srcEls.forEach((el, i) => {
      const at = i * 0.18;
      t.add(() => el.classList.add("lit"), at);
      flyChip(t, el, hub, at);
    });

    // Phase 2: the hub pulses as it fills.
    t.add(() => {
      captionEl.innerHTML = CAP_HUB;
    }, ">-0.1");
    t.to(hub, { scale: 1.12, duration: 0.25, ease: "power2.out" }, "<");
    t.to(
      hub,
      {
        boxShadow: "0 0 22px rgba(106,79,176,0.55)",
        duration: 0.25,
        yoyo: true,
        repeat: 1,
      },
      "<",
    );
    t.to(hub, { scale: 1, duration: 0.3, ease: "power2.inOut" });

    // Phase 3: fan-out. The hub emits a chip to each consumer dApp.
    t.add(() => {
      captionEl.innerHTML = CAP_FANOUT;
    });
    dstEls.forEach((el) => {
      flyChip(t, hub, el, ">-0.4", () => el.classList.add("lit"));
    });
  };

  // Silent reader: play once when scrolled into view.
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) {
        io.disconnect();
        play();
      }
    },
    { threshold: 0.3 },
  );
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

// Run-guard at the very bottom: all const arrow helpers above are defined by
// the time this executes (const arrows are NOT hoisted, so this must come last).
const fig = document.getElementById("sharedliquidity-figure");
if (fig) { try { initFigure(fig); } catch (e) { console.error("sharedLiquidity figure failed", e); } }
