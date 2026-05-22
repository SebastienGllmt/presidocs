// Interactive hash-function figure for posts/hash-functions.html.
//
// Why this is an external module rather than an inline <script>:
// production CSP is `script-src 'self'` with no 'unsafe-inline' (see
// shared/securityHeaders.ts), so executable inline scripts are blocked.
// The post references this file with <script type="module" src="…">, which
// Bun's bundler emits as a hashed same-origin asset — CSP-clean. GSAP only
// mutates `element.style` (CSSOM), which CSP does not govern, so the
// animation itself needs no policy relaxation.
//
// Design notes:
//   - Progressive enhancement. The post ships a static <svg class="hash-static">
//     as the no-JS fallback / initial frame; this module hides it and injects
//     the live stage, marking the figure `.hash-enhanced`.
//   - Real SHA-256 via crypto.subtle — the fingerprint is genuine, so typing
//     anything (or flipping one character) shows the true avalanche effect.
//   - Narration-synced. The narrator toggles `narration-active` on `#diagram`
//     when the "diagram" mark plays (client/narrator.ts); we observe that and
//     replay the intro so a listener sees the figure move on cue. No new
//     player API — we ride the existing highlight class.
//   - Commentable. Everything renders inside <figure id="diagram">, which is
//     the unit the comment system anchors graphics to.
import { gsap } from "gsap";

const HEX = "0123456789abcdef";
const randHex = () => HEX.charAt((Math.random() * 16) | 0);
const enc = new TextEncoder();

async function sha256Hex(str: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const firstDiff = (a: string, b: string): number => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
};

const debounce = <A extends unknown[]>(fn: (...a: A) => void, ms: number) => {
  let t: ReturnType<typeof setTimeout>;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

const fig = document.getElementById("diagram");
if (fig) initHashFigure(fig);

function initHashFigure(figure: HTMLElement): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Build the live stage and slot it in front of the <figcaption>, then hide
  // the static SVG fallback.
  const stage = document.createElement("div");
  stage.className = "hash-fig";
  stage.innerHTML = `
    <div class="stage">
      <div class="col">
        <div class="label">input</div>
        <div class="chars" data-in-chars></div>
      </div>
      <div class="col">
        <div class="machine-box" data-machine>hash()<br /><small>SHA-256</small></div>
      </div>
      <div class="col">
        <div class="label">256-bit fingerprint (hex)</div>
        <div class="hex-grid" data-hex-grid></div>
      </div>
    </div>
    <div class="controls">
      <input data-text-input value="hello" maxlength="40" aria-label="hash input" />
      <button type="button" data-flip-btn>Flip one character</button>
      <button type="button" data-replay-btn>Replay</button>
      <p class="hint" data-hint></p>
    </div>`;
  const caption = figure.querySelector("figcaption");
  figure.insertBefore(stage, caption);
  figure.classList.add("hash-enhanced");

  const q = <T extends Element>(sel: string) => stage.querySelector(sel) as T;
  const inChars = q<HTMLElement>("[data-in-chars]");
  const hexGrid = q<HTMLElement>("[data-hex-grid]");
  const machine = q<HTMLElement>("[data-machine]");
  const textInput = q<HTMLInputElement>("[data-text-input]");
  const flipBtn = q<HTMLButtonElement>("[data-flip-btn]");
  const replayBtn = q<HTMLButtonElement>("[data-replay-btn]");
  const hint = q<HTMLElement>("[data-hint]");

  const cells = Array.from({ length: 64 }, () => {
    const c = document.createElement("div");
    c.className = "cell";
    c.textContent = "·";
    hexGrid.appendChild(c);
    return c;
  });

  let displayed = "·".repeat(64); // currently-settled fingerprint
  let current: gsap.core.Timeline | null = null; // in-flight intro timeline

  const idleHint = "Type below, or flip one character, and watch the fingerprint change.";

  function renderInput(str: string, flippedIndex = -1): HTMLElement[] {
    inChars.innerHTML = "";
    return [...str].map((ch, i) => {
      const el = document.createElement("div");
      el.className = "char" + (i === flippedIndex ? " flipped" : "");
      el.textContent = ch === " " ? "␣" : ch;
      inChars.appendChild(el);
      return el;
    });
  }

  // Per-cell "slot-machine" scramble that settles on the real hex digit.
  // Tween a throwaway proxy per cell; drive the DOM from the callbacks.
  function settleHash(target: string, avalanche: boolean): number {
    let changed = 0;
    cells.forEach((cell, i) => {
      const finalCh = target.charAt(i);
      const didChange = displayed.charAt(i) !== finalCh;
      if (didChange) changed++;
      cell.classList.remove("changed");
      if (reduced) {
        cell.textContent = finalCh;
        if (avalanche && didChange) cell.classList.add("changed");
        return;
      }
      gsap.to({ t: 0 }, {
        t: 1,
        duration: 0.45,
        delay: i * 0.01,
        ease: "none",
        onStart() { cell.classList.add("scrambling"); },
        onUpdate() { cell.textContent = randHex(); },
        onComplete() {
          cell.textContent = finalCh;
          cell.classList.remove("scrambling");
          if (avalanche && didChange) cell.classList.add("changed");
        },
      });
    });
    displayed = target;
    return changed;
  }

  function announce(avalanche: boolean, changed: number): void {
    hint.innerHTML = avalanche
      ? `One character changed &rarr; <b>${changed} of 64</b> hex digits flipped.`
      : idleHint;
  }

  async function run(str: string, avalanche = false, flippedIndex = -1): Promise<void> {
    current?.kill();
    const charEls = renderInput(str, flippedIndex);
    const target = await sha256Hex(str);

    if (reduced) {
      announce(avalanche, settleHash(target, avalanche));
      return;
    }

    const tl = gsap.timeline();
    current = tl;
    // 1. input characters pop in, staggered
    tl.from(charEls, {
      opacity: 0, y: 14, scale: 0.6, duration: 0.3, stagger: 0.05, ease: "back.out(2)",
    });
    // 2. the machine churns
    tl.to(machine, { rotation: "+=3", duration: 0.05, repeat: 9, yoyo: true, ease: "none" }, ">-0.05");
    tl.to(machine, { scale: 1.08, duration: 0.2, yoyo: true, repeat: 1 }, "<");
    // 3. once it has churned, settle the fingerprint
    tl.add(() => announce(avalanche, settleHash(target, avalanche)));
  }

  // --- interactivity ---------------------------------------------------
  let lastStr = textInput.value;

  textInput.addEventListener("input", debounce(() => {
    const v = textInput.value;
    const flipped = firstDiff(lastStr, v);
    lastStr = v;
    void run(v, true, flipped);
  }, 220));

  flipBtn.addEventListener("click", () => {
    const v = textInput.value || "a";
    const i = (Math.random() * v.length) | 0;
    let nc: string;
    do { nc = String.fromCharCode(97 + ((Math.random() * 26) | 0)); } while (nc === v[i]);
    const nv = v.slice(0, i) + nc + v.slice(i + 1);
    textInput.value = nv;
    lastStr = nv;
    void run(nv, true, i);
  });

  replayBtn.addEventListener("click", () => {
    displayed = "·".repeat(64);
    cells.forEach((c) => { c.textContent = "·"; c.className = "cell"; });
    void run(textInput.value);
  });

  // Play the intro the first time the figure scrolls into view (covers the
  // silent reader). `once`-style: disconnect after firing.
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { io.disconnect(); void run(textInput.value); }
    }
  }, { threshold: 0.35 });
  io.observe(figure);

  // Replay the intro when narration reaches the "diagram" mark — the player
  // adds `narration-active` to #diagram at that moment (client/narrator.ts).
  let wasActive = figure.classList.contains("narration-active");
  const mo = new MutationObserver(() => {
    const active = figure.classList.contains("narration-active");
    if (active && !wasActive) void run(textInput.value);
    wasActive = active;
  });
  mo.observe(figure, { attributes: true, attributeFilter: ["class"] });

  hint.textContent = idleHint;
}
