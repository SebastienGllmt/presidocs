---
name: figure-journey
description: Create, convert, or audit an animated figure against the FigureJourney contract — the engine standard that makes a figure forward-seekable, deterministically capturable, and driver-controllable so the live narrator and the offline video renderer drive the same animation. Use when authoring a new animated figure, converting an existing GSAP figure to the contract, or auditing a figure for conformance (the 15 authoring rules + the conformance gate). Examples - "make this figure narration-drivable", "create or audit a figure", "does my figure pass the FigureJourney contract", "why does my figure freeze when narration drives it".
user-invocable: true
---

# figure-journey

Create or audit an animated figure so it satisfies the **FigureJourney contract** — the engine standard in `client/figureAnimation.ts` that lets one registered animation be driven by two consumers (the live in-page narrator and the offline video renderer) and captured byte-deterministically. A conformant figure is **forward-seekable**, **deterministically capturable**, and **driver-controllable**. A non-conformant one drifts between page and video, breaks the content-hash cache, or silently freezes under a driver.

See `engine/methodology.md` → "Animated figures" for how figures are wired (`client/figures/`, GSAP, progressive enhancement, reduced-motion) and the "Video export" section for the renderer/capture context that consumes a journey. This skill is the authoring/audit checklist for the contract itself; the methodology gives the surrounding system.

## What this is / when to use

A figure is a content-repo DOM/JS GSAP visualization that progressively enhances a `<figure id="…">`. The **FigureJourney** is an adapter surface over GSAP (GSAP stays the engine; the contract does not replace it) that exposes the figure's animation as a **pure forward renderer plus a label/segment map**, so the engine can:

- **drive** it from the audio clock on the live page (continuous loop, or stepped snap-and-hold), and
- **capture** it headlessly at fixed fps into a deterministic video clip.

Use this skill when you are: authoring a new animated figure that should sync to narration or appear in the rendered video; converting an existing self-playing figure to the contract; or auditing a figure that is misbehaving (page/video disagree, cache won't stay warm, the figure freezes when narration claims it).

## The contract interface

From `client/figureAnimation.ts` (cite these real symbols):

```ts
export interface FigureStep {           // a labeled segment, projected from GSAP labels
  readonly label: string;
  readonly startMs: number;             // steps[0].startMs === 0
  readonly endMs: number;               // contiguous & increasing; last endMs === durationMs
}

export interface FigureJourney {
  readonly durationMs: number;          // one play-through (may bake loop-dwell — rule 15)
  readonly steps: ReadonlyArray<FigureStep>;
  reset(): void;                        // snap to frame 0; TAKES EXCLUSIVE CONTROL (rule 7)
  seek(ms: number): void;               // render the frame at ms; FORWARD-ONLY between reset()s
}

registerFigureJourney(id, journey)      // register under the figure's element id; fires `presidocs:figure-ready`
getFigureJourney(id)                    // a driver looks one up
listFigureJourneys()                    // enumerate all (à la document.getAnimations()); the conformance gate uses this
stepsFromLabels(labels, durationSec)    // project tl.labels (+ tl.duration()) into steps[] — the ONE source of truth for steps
buildLoopingJourney({ playMs, labels, loopGapMs, seek, reset })  // bake loop-dwell into durationMs/steps (rule 15)
```

**Mental model: pure renderer + external clock.** The figure is dumb. The *only* way to advance it is `seek()` forward. There is deliberately **no** `play`/`pause`/`onComplete`/`finished`/`playbackRate` on the figure — all "transport" lives on **drivers** that own a clock and call `seek()`:

- "pause" = the driver stops advancing (hold the current frame);
- "play"/"start" = the driver begins advancing;
- "advance to step" = the driver seeks to a labeled time.

Three consumers, one primitive, three clocks: **capture** (fixed-fps virtual clock, `generate/capture-figures.ts`), **narration** (rAF real-time clock gated on the staged figure, `client/narrator.ts`), and **autoplay** (the figure's own scroll-into-view loop — stays *inside* the figure by decision, not an engine driver). There is no single `JourneyDriver` type; drivers are distributed.

**Locked rule: forward-seek, not random-access.** `seek()` advances monotonically between `reset()`s. To revisit an earlier point you call `reset()` and replay forward — never a coarse backward or random jump. **Why** (and why this beats the Remotion-style `render(t)` random-access alternative that was rejected): roughly half of a figure's meaning is discrete, non-numeric state (`textContent`, `classList`, `innerHTML`) set via GSAP `tl.call(...)`, which GSAP does not make cleanly random-access. Forcing random access would mean re-expressing every text/class change as a numeric-proxy `onUpdate` — a structural rewrite and a permanent authoring tax — to buy render-farm parallelism we don't need. Forward-seek + `reset()`-and-replay covers click-to-step, narration stepping, and looping at millisecond replay cost. This is also why `seek` is *not* named after WAAP `currentTime` / Lottie `goToAndStop`, which imply random access.

## The 15 authoring rules (the standard)

Every conformant figure obeys these. They are the heart of the contract.

1. **One journey, two consumers; no divergent self-play.** The registered journey is exactly what the renderer scrubs and what the narrator drives. The figure's own live triggers must play *the journey's tour* — not a separate intro/stagger that diverges from it.
2. **Finite, paused, forward-seekable timeline.** Build on `gsap.timeline({ paused: true })`; `seek(ms)` = `tl.time(ms/1000)`. No infinite or physics-driven animation. A deliberately-static figure registers **no** journey and falls back to its rendered still — that is a valid choice, not a violation.
3. **Forward in small steps, no coarse jumps.** Advance in increments small enough to cross *every* `tl.call()`; revisit earlier states via `reset()`+replay. This small-step guarantee is precisely *why* `.call()` for discrete state is allowed.
4. **Steps projected from GSAP labels** via `stepsFromLabels(tl.labels, tl.duration())` and `tl.addLabel(...)`. Never hand-maintain a parallel step list — labels are the one source of truth.
5. **Always register, even under reduced motion.** Registration ≠ playback; the *consumer* decides. The live page shows the settled (end) state under reduced motion; the headless renderer always captures full motion. Do not gate `registerFigureJourney` behind a motion check.
6. **Keying:** `<figure id>` === narration mark name === registry key. One id ties the markup, the `<mark name=…>`, and the journey together.
7. **`reset()` takes exclusive control** (the `driven` guard). When a driver claims the figure, the figure's own self-play must **stand down**. Implement a `let driven = false`; set `driven = true` in `reset()` and have every live/autoplay/interaction handler early-out `if (driven) return;`. *(The single most important rule — its absence lets a self-playing figure fight the driver; see "the freeze class" below.)*
8. **Any build-time-applying tween uses `immediateRender: false`** — that means `from`, `fromTo`, **and** a `duration: 0 .to(...)` used as a state-set. Otherwise the tween applies at build/frame-0 and corrupts the captured first frame.
9. **No detached tweens reachable by `seek()`.** Every visual change lives on the journey timeline. Never fire a bare `gsap.to(...)` from an `onStart`/`onComplete`/callback — a seek can't reproduce it, so capture and live driving diverge.
10. **Build-once-and-reuse iff no nodes are spawned mid-animation.** If the figure `appendChild`s nodes as it runs, it must **rebuild the timeline on `reset()`** (rebuild-on-reset). **Sub-rule 10a:** append a spawned node via a timeline `.call()` *at its reveal moment*, not at build time — appending at build time shows it on frame 0, a wrong-but-deterministic first frame the determinism check cannot catch.
11. **No `Math.random` / wall-clock** on any journey-reachable path. Capture must be byte-reproducible; any entropy breaks content-addressing.
12. **No `gsap.set(el, { clearProps: "all" })` to reset.** Leftover inline-style residue serializes inconsistently across passes. Reset to **explicit values** instead.
13. **Tab/phase figures author a "tour" with `animate=false` on the journey path.** A figure whose `render()` does a detached reveal must take an `animate` boolean (standardized name: **`animate`**) that is `false` when invoked on the journey path, so the journey builds the state without firing the detached reveal animation.
14. **Pervasive-detached figures keep their live code but author a separate seekable journey — and never `gsap.killTweensOf(sharedEls)` on a build-once journey.** `killTweensOf` reaches into the paused journey timeline and silently freezes it. Two safe resets: **(a) rebuild-on-reset**, or **(b) kill the live tween *instances*** (the specific tween objects), never the elements.
15. **Bake a looping figure's loop-dwell into the journey** with `buildLoopingJourney` (`figureAnimation.ts:132`): extend `durationMs`/`steps` by `loopGapMs` and clamp tail seeks to the held final frame. Otherwise drivers that loop by `durationMs` (the compositor; narration continuous mode) restart the instant motion ends — the page pauses between loops but the video snaps. Feed the **same** `LOOP_GAP` to both the figure's live free-run loop and the helper. Applies to every looping figure.

## Creating a figure — checklist

1. **Pick the figure shape**, which decides your reset strategy:
   - *Build-once* (all nodes exist up front, timeline animates them): build the timeline once, `seek()` scrubs it, `reset()` just `pause(0)` + restore explicit values (rule 12). Use `stepsFromLabels`.
   - *Build-once that spawns nodes mid-animation*: append via `.call()` at the reveal moment (rule 10a) **and** rebuild on `reset()` (rule 10/14a).
   - *Tabbed/phase figure with a detached reveal*: add an `animate` flag (rule 13); the journey path passes `animate=false`.
   - *Looping figure*: wrap with `buildLoopingJourney`, share `LOOP_GAP` with the live loop (rule 15).
   - *Deliberately static*: register **nothing** — the still fallback is the contract-correct path (rule 2).
2. **Build a `gsap.timeline({ paused: true })`** (rule 2). Add labels with `tl.addLabel` at each meaningful state (rule 4) — these become your narration step join-points.
3. **Audit your tweens against rules 8/9/11/12** as you write them: `immediateRender:false` on every `from`/`fromTo`/`duration:0 .to`; no detached `gsap.to` in callbacks; no `Math.random`/wall-clock; reset to explicit values, never `clearProps:"all"`.
4. **Add the `driven` guard** (rule 7): `reset()` sets `driven = true`, stands down live/autoplay, and snaps to frame 0; every self-play/interaction entry point early-outs while `driven`.
5. **Register under the figure's id** (rule 6) with `registerFigureJourney(id, journey)` where `journey.steps = stepsFromLabels(tl.labels, tl.duration())` and `journey.seek(ms) = tl.time(ms/1000)` — or via `buildLoopingJourney` for loopers.
6. **Add narration pointers** in the post (orthogonal to the highlight `name`): `figure="<id>"` stages the figure; `figure="none"`/`""` clears it; omit to carry it. `step="<label>"` drives the staged figure to a labeled state (forward-only, targets the staged figure). A staged figure holds frame 1 until a driving event advances it.
7. **Run the conformance gate** (below) and iterate until green.

## Auditing a figure — checklist

Run the conformance gate and read its two distinct checks:

```bash
bun run test:e2e        # the e2e tier; e2e/figureJourney.e2e.ts is the conformance gate
```

`e2e/figureJourney.e2e.ts` loads each post (and the dev-only `_figjourneys` fixture post), enumerates `listFigureJourneys()`, and per journey asserts the structural invariants plus two semantic checks. A figure that no published post embeds can still be exercised via the `_`-prefixed `_figjourneys` fixture (the dev route serves it; `build-html` skips it so it never deploys).

- **Structural:** registered under its id; `durationMs > 0`; `steps[0].startMs === 0`; contiguous increasing segments; last `endMs === durationMs`; `reset()`+forward `seek()` across `[0, durationMs]` at capture fps throws nothing and yields **≥2 distinct frames**; `seek(durationMs)` idempotent. Sampling is **inclusive of `durationMs`** (else a state set on the last frame is dropped).
- **Determinism check** — two full passes are byte-identical at the end. This is the load-bearing catch for **rules 9, 11, 12** (detached tweens, randomness/wall-clock, `clearProps` residue). If this fails, hunt for entropy or non-timeline visuals on the seek path.
- **Integrity check** — `reset()` must not *collapse* the journey's distinct-frame count versus a pristine (pre-reset) pass (must stay ≥60%). This catches the one class determinism structurally **cannot**: a build-once journey that runs `gsap.killTweensOf(sharedEls)` in `reset()` reaches into its own paused timeline and silently **freezes** — and a frozen journey is still perfectly deterministic, so determinism-only testing passes it green. Rebuild-on-reset figures are **exempt** from the integrity check (they have no pristine pre-reset journey — `seek()` is a no-op until `reset()` builds the timeline).

**The build-once-frozen-by-`killTweensOf` failure class to look for** when a figure renders fine alone but freezes the instant narration/capture claims it: a build-once timeline whose `reset()` calls `gsap.killTweensOf(sharedEls)`. The fix is rule 14 — rebuild-on-reset, or kill the specific live tween *instances*, never the shared elements — paired with rule 7's `driven` guard so self-play stands down for the driver. The integrity check is the regression guard for the whole class; the `driven`-guard test in the same file is the companion.

There is **no** reduced-motion assertion in the gate (the renderer always runs full motion) and **no** static lint for the rule-8 `immediateRender:false` omission — that class is caught at runtime by the determinism check, so verify rule 8 by reading the tweens.

## Pointers

- `engine/methodology.md` → **"Animated figures"** — how figures are wired (`client/figures/`, GSAP, progressive enhancement, reduced-motion), the surrounding context for this contract.
- `engine/methodology.md` → the **"Video export"** section — the offline renderer and headless capture that consume a journey (the second of the two drivers this contract serves).
- `client/figureAnimation.ts` — the contract code and the only authoritative symbol list.
- The narration→figure pointer model (`figure=`/`step=` on `<mark>`) and per-step/live driving are the *consumers* of a conformant journey; a figure only needs to satisfy the 15 rules above for both to work by construction.
