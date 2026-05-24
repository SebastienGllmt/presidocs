// Interactive figure for posts/offer-files.html: why a market maker needs cheap,
// fast cancels — and why a slow chain can't give them.
//
// The point, made visually: a market maker keeps a BUY quote just below and a
// SELL quote just above a moving "fair price", earning the spread when both get
// hit. But the fair price drifts, so those two quotes keep going stale and must
// be CANCELLED + RE-POSTED to follow it — and on this chain every cancel is an
// on-chain transaction. We animate a fair-price line walking up and down a
// vertical price track; the maker's bid/ask chase it. On a FAST chain they keep
// up (collect the spread). On the slow Midnight ZK chain the re-quote lags, so
// the fair price periodically crosses a stale quote and a taker "picks it off"
// at a bad price — the maker loses money. A readout narrates cause→effect and a
// tally counts spread earned, losses, and on-chain cancels.
//
// External module for the same CSP reason as the other figures (see
// client/figures/hashAvalanche.ts). GSAP only writes CSSOM. Enhancement
// contract is identical: static SVG fallback, `.mm-enhanced`,
// IntersectionObserver intro, `narration-active` replay, reduced-motion aware.
import { gsap } from "gsap";

// Price geometry. The track spans LO..HI; we render prices as a top offset (%).
const LO = 2.7;
const HI = 3.3;
const MID = (LO + HI) / 2;
const SPREAD = 0.04; // bid sits SPREAD/2 below fair, ask SPREAD/2 above

// Discrete fair-price walk (one entry = one "tick" of the market).
const WALK = [3.0, 3.04, 3.08, 3.06, 3.12, 3.16, 3.12, 3.06, 3.0, 2.96, 2.92, 2.96, 3.0];

interface Chain {
  label: string;
  // seconds the maker's quote lags the price after a move (re-quote latency)
  lag: number;
  // probability a lagging quote gets picked off on a given move
  pickoff: number;
}
const FAST: Chain = { label: "Fast chain", lag: 0.0, pickoff: 0 };
const SLOW: Chain = { label: "Midnight (slow ZK chain)", lag: 1.0, pickoff: 1 };

const FIRST = WALK[0] ?? MID;
const LAST = WALK[WALK.length - 1] ?? MID;

const fig = document.getElementById("mm-figure");
if (fig) {
  try {
    initMarketMaker(fig);
  } catch (err) {
    console.error("marketMaker figure failed to initialise", err);
  }
}

function initMarketMaker(figure: HTMLElement): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const usd = (n: number) => `$${n.toFixed(2)}`;
  // map a price to a vertical position on the track (0% = top = HI, 100% = LO)
  const yOf = (p: number) => `${((HI - p) / (HI - LO)) * 100}%`;

  const stage = document.createElement("div");
  stage.className = "mm-fig";
  stage.innerHTML = `
    <div class="mm-head">
      <span class="mm-title">You're the market maker. Quote just under and over the price; pocket the gap.</span>
      <span class="mm-seg" role="group" aria-label="chain speed">
        <button type="button" data-chain="fast" class="on">Fast chain</button>
        <button type="button" data-chain="slow">Midnight (slow ZK chain)</button>
      </span>
    </div>

    <div class="mm-main">
      <div class="mm-track" data-track>
      <div class="axis"><span class="ax-hi">${usd(HI)}</span><span class="ax-lo">${usd(LO)}</span></div>
      <div class="lane">
        <div class="band" data-band></div>
        <div class="line ask" data-ask><span class="lbl">SELL <b data-askpx>${usd(MID + SPREAD / 2)}</b></span></div>
        <div class="line fair" data-fair><span class="lbl">fair price <b data-fairpx>${usd(MID)}</b></span></div>
        <div class="line bid" data-bid><span class="lbl">BUY <b data-bidpx>${usd(MID - SPREAD / 2)}</b></span></div>
        <div class="pickoff" data-flash>picked off &mdash; sold low / bought high</div>
      </div>
      </div>
      <div class="mm-cancels" data-cancels-box>
        <div class="mm-cancels-top">
          <b data-cancels>0</b>
          <span>on-chain cancels</span>
        </div>
        <div class="mm-cancels-bot" data-fin-box>
          <b data-fin>$0.00</b>
          <span data-fin-lbl>spread earned</span>
        </div>
      </div>
    </div>

    <p class="readout" data-readout>The maker keeps a <b class="b">BUY</b> just below and a <b class="a">SELL</b> just above the fair price, earning the spread when both fill. Watch the fair price drift &mdash; the quotes must chase it.</p>`;

  const caption = figure.querySelector("figcaption");
  figure.insertBefore(stage, caption);
  figure.classList.add("mm-enhanced");

  const q = <T extends Element>(s: string) => stage.querySelector(s) as T;
  const askEl = q<HTMLElement>("[data-ask]");
  const bidEl = q<HTMLElement>("[data-bid]");
  const fairEl = q<HTMLElement>("[data-fair]");
  const bandEl = q<HTMLElement>("[data-band]");
  const flashEl = q<HTMLElement>("[data-flash]");
  const askPx = q<HTMLElement>("[data-askpx]");
  const bidPx = q<HTMLElement>("[data-bidpx]");
  const fairPx = q<HTMLElement>("[data-fairpx]");
  const finEl = q<HTMLElement>("[data-fin]");
  const finLblEl = q<HTMLElement>("[data-fin-lbl]");
  const cancelsEl = q<HTMLElement>("[data-cancels]");
  const cancelsBox = q<HTMLElement>("[data-cancels-box]");
  // Each price move cancels a whole LADDER of quotes (the figure abstracts the
  // many resting orders above/below the best bid/ask), so the counter jumps.
  const CANCELS_PER_MOVE = 12;
  const readout = q<HTMLElement>("[data-readout]");
  const fastBtn = q<HTMLButtonElement>('[data-chain="fast"]');
  const slowBtn = q<HTMLButtonElement>('[data-chain="slow"]');

  let chain: Chain = FAST;
  let earned = 0;
  let lost = 0;
  let cancels = 0;
  let tl: gsap.core.Timeline | null = null;

  // place a quote line (and the price band) at a given fair price
  const placeQuotes = (fair: number, snap: boolean): void => {
    const ask = fair + SPREAD / 2;
    const bid = fair - SPREAD / 2;
    const dur = snap ? 0 : 0.35;
    gsap.to(askEl, { top: yOf(ask), duration: dur, ease: "power2.out" });
    gsap.to(bidEl, { top: yOf(bid), duration: dur, ease: "power2.out" });
    gsap.to(bandEl, { top: yOf(ask), height: `${(SPREAD / (HI - LO)) * 100}%`, duration: dur, ease: "power2.out" });
    askPx.textContent = usd(ask);
    bidPx.textContent = usd(bid);
  };

  const placeFair = (fair: number, snap: boolean): void => {
    gsap.to(fairEl, { top: yOf(fair), duration: snap ? 0 : 0.45, ease: "power1.inOut" });
    fairPx.textContent = usd(fair);
  };

  const setStats = (): void => {
    cancelsEl.textContent = String(cancels);
    // Bottom half of the box: the chain-relevant financial outcome.
    if (chain === FAST) { finLblEl.textContent = "spread earned"; finEl.textContent = usd(earned); }
    else { finLblEl.textContent = "lost to pick-offs"; finEl.textContent = usd(lost); }
  };

  // Eye-catching bump when the cancel count jumps: pop the big number.
  const popCancels = (): void => {
    cancelsEl.textContent = String(cancels);
    if (reduced) return;
    gsap.fromTo(cancelsBox, { scale: 1.35 }, { scale: 1, duration: 0.5, ease: "back.out(2.5)" });
    cancelsBox.classList.add("flash");
    gsap.delayedCall(0.5, () => cancelsBox.classList.remove("flash"));
  };

  const setChain = (c: Chain): void => {
    chain = c;
    fastBtn.classList.toggle("on", c === FAST);
    slowBtn.classList.toggle("on", c === SLOW);
    stage.classList.toggle("is-slow", c === SLOW);
    setStats(); // refresh the box's bottom half (spread earned vs loss) for the new chain
  };

  const resetState = (): void => {
    tl?.kill();
    tl = null;
    earned = 0;
    lost = 0;
    cancels = 0;
    setStats();
    flashEl.classList.remove("show");
    stage.classList.remove("picked");
    placeFair(FIRST, true);
    placeQuotes(FIRST, true);
  };

  // Render the steady, "everything caught up" final frame (reduced motion / end).
  const showFinal = (): void => {
    placeFair(LAST, true);
    placeQuotes(LAST, true);
  };

  // Build the looping timeline that walks the fair price and chases it.
  const build = (): gsap.core.Timeline => {
    const t = gsap.timeline({ repeat: -1, repeatDelay: 0.6 });
    // start clean each loop
    t.add(() => {
      earned = 0;
      lost = 0;
      cancels = 0;
      setStats();
      placeFair(FIRST, true);
      placeQuotes(FIRST, true);
      readout.innerHTML = chain === FAST
        ? `<b class="b">BUY</b> below, <b class="a">SELL</b> above. The fair price is about to move &mdash; on a <b>fast chain</b> the maker re-quotes instantly and keeps earning the spread.`
        : `Same job, but on the <b>slow ZK chain</b> a cancel is an on-chain tx with slow finality. Watch the quotes <b>lag</b> behind the price.`;
    });
    t.to({}, { duration: 0.9 });

    for (let i = 1; i < WALK.length; i++) {
      const prev = WALK[i - 1] ?? FIRST;
      const fair = WALK[i] ?? FIRST;
      const up = fair > prev;

      // 1. the fair price moves first — quotes are now momentarily stale
      t.add(() => {
        placeFair(fair, false);
        stage.classList.add("stale");
        readout.innerHTML = `Price moved to <b>${usd(fair)}</b>. The old <b class="b">BUY</b>/<b class="a">SELL</b> are mispriced &mdash; cancel both and re-post around the new price.`;
      });
      t.to({}, { duration: 0.45 });

      if (chain === FAST) {
        // fast: re-quote immediately, collect the spread, 2 cancels per move
        t.add(() => {
          placeQuotes(fair, false);
          stage.classList.remove("stale");
          cancels += CANCELS_PER_MOVE;
          earned += SPREAD;
          setStats();
          popCancels();
          readout.innerHTML = `Re-quoted instantly &mdash; a whole ladder cancelled and re-posted (<b>${CANCELS_PER_MOVE} on-chain cancels</b>). Both sides fill around the new price, <b class="g">+${usd(SPREAD)}</b>. The maker stays glued to the market.`;
        });
        t.to({}, { duration: 0.7 });
      } else {
        // slow: quotes lag. The price keeps drifting in the same direction,
        // so a stale quote is on the wrong side and gets picked off.
        t.to({}, { duration: chain.lag * 0.55 }); // visible lag while quotes sit stale
        t.add(() => {
          // a taker hits the stale quote at the old price → maker loses the move
          lost += SPREAD;
          cancels += CANCELS_PER_MOVE;
          setStats();
          popCancels();
          flashEl.textContent = "Stale price → LOSS";
          flashEl.classList.add("show");
          stage.classList.add("picked");
          readout.innerHTML = `Too slow. Before the cancel confirmed, a taker hit your stale ${up ? "<b class='a'>SELL</b>" : "<b class='b'>BUY</b>"} at the old price &mdash; <b class="r">−${usd(SPREAD)}</b>. That's the cost of cancels you can't land in time.`;
        });
        t.to({}, { duration: 0.85 });
        t.add(() => {
          flashEl.classList.remove("show");
          stage.classList.remove("picked");
          placeQuotes(fair, false); // finally catches up — until the next move
          stage.classList.remove("stale");
        });
        t.to({}, { duration: 0.5 });
      }
    }

    // hold the verdict before looping
    t.add(() => {
      readout.innerHTML = chain === FAST
        ? `Result on a <b>fast chain</b>: cancels land instantly, quotes track the price, the maker banks <b class="g">${usd(earned)}</b> across the run. This is workable market making.`
        : `Result on the <b>slow chain</b>: every lagging cancel is a chance to get picked off &mdash; <b class="r">${usd(lost)}</b> lost. Serious market making is quietly impossible. <b>That's</b> why we need cheap, fast cancels.`;
    });
    t.to({}, { duration: 2.0 });
    return t;
  };

  const play = (): void => {
    if (reduced) {
      showFinal();
      readout.innerHTML = `On a fast chain the maker re-quotes instantly and keeps the spread. On the slow ZK chain each cancel is an on-chain tx that lands too late, so stale quotes get picked off at a loss &mdash; the case for cheap, fast cancels.`;
      return;
    }
    resetState();
    tl = build();
  };

  fastBtn.addEventListener("click", () => { setChain(FAST); play(); });
  slowBtn.addEventListener("click", () => { setChain(SLOW); play(); });

  // initial frame
  placeFair(FIRST, true);
  placeQuotes(FIRST, true);
  setStats();

  // Silent reader: start when scrolled into view.
  let started = false;
  const intro = (): void => {
    if (started) return;
    started = true;
    play();
  };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.disconnect(); intro(); }
  }, { threshold: 0.3 });
  io.observe(figure);

  // Listener: replay from the top when narration reaches the paired mark.
  let active = figure.classList.contains("narration-active");
  const mo = new MutationObserver(() => {
    const now = figure.classList.contains("narration-active");
    if (now && !active) { started = true; play(); }
    active = now;
  });
  mo.observe(figure, { attributes: true, attributeFilter: ["class"] });
}
