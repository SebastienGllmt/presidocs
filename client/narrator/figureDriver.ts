// methodology.md → Narrator — the live figure driver: owns the staged figure's
// journey clock, advancing it off the audio clock in the same rAF tick that
// tracks the active mark (claim on stage-on, forward-seek, loop, release on
// stage-off, detach on reader interaction).

import type { Narrator } from "../narrator.ts";
import { stagedFigureAt, figureSeekPlan } from "../narratorTiming.ts";
import { getFigureJourney, type FigureJourney } from "../figureAnimation.ts";
import { asMs, type Milliseconds } from "../../shared/time.ts";

export class FigureDriver {
  constructor(private readonly sys: Narrator) {}

  // ----- Narration figure driver (methodology.md → "Live figure driving") -----------------------------
  // The figure currently on the stage *and driven* by the narration clock,
  // resolved from the timeline's figure pointer (`resolveActiveFigure`), NOT
  // from the active mark's `name` (47 decoupled them). `null` = empty stage.
  private stagedFigureId: string | null = null;
  // The claimed journey for `stagedFigureId` (undefined-on-page figures and
  // figures with no registered journey leave this null — nothing to drive).
  private stagedJourney: FigureJourney | null = null;
  // Master-track time (ms) at which the current figure's span began (its
  // staging mark — `stagedFigureAt().sinceMs`, NOT the tick we noticed it). The
  // journey is advanced by `tMs - figureStagedAtMs`, so the figure rides the
  // audio clock, is frame-perfect on pause (clock frozen), and a scrub into the
  // middle of a span resumes the figure mid-animation rather than from frame 1.
  private figureStagedAtMs: Milliseconds = asMs(0);
  // Last journey position we seeked to. `figureSeekPlan` reads it to decide
  // forward-step vs. reset()+replay (a loop wrap or backward scrub); a fresh
  // claim sets it to +Infinity to force the reset-and-sweep-from-0.
  private figureLastSeekMs = 0;
  // Step ceiling for forward seeks (rule 3: advance no coarser than this so
  // every timeline `.call()` is crossed). Matches the capture/conformance fps.
  private static readonly FIGURE_STEP_MS = 1000 / 30;
  // §6 interactive detach: a click on the staged figure's own controls hands
  // control to the figure's handlers; the driver stops advancing it (holding
  // the reader's hand-set state). Re-attach happens when the figure is re-staged
  // (the claim path `reset()`s from a clean baseline). Tracked so we can detach
  // the listener when the stage changes.
  private figureDetached = false;
  private figureDetachEl: HTMLElement | null = null;
  private figureDetachHandler: ((e: Event) => void) | null = null;

  // The narration figure driver (methodology.md → "Live figure driving"). Runs every rAF tick from
  // `updateActive`. Resolves which figure the timeline stages at `tMs` (the
  // `figure` pointer, NOT the `name` highlight) and, when it has a registered
  // journey, owns that journey's clock: claim on stage-on (`reset()`, which
  // trips the figure's `driven` guard so its own scroll/narration self-play
  // stands down), advance by forward seek from the audio clock, loop if the
  // staged span outlasts one play-through, release on stage-off. Pause is
  // implicit: the ticker stops when audio pauses, so the figure holds its frame.
  updateActiveFigure(tMs: Milliseconds) {
    if (!this.sys.manifest) return;
    // Reduced motion (rule 5): no real-time animation. The narration driver
    // stands down entirely so it never `reset()`s a figure to frame 1 and then
    // freezes it; each figure's own triggers render its settled state instead.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (this.stagedFigureId !== null || this.stagedJourney) this.releaseStagedFigure();
      return;
    }

    const { id: stagedId, sinceMs, step } = stagedFigureAt(this.sys.manifest.marks, tMs);
    if (stagedId !== this.stagedFigureId) {
      // Stage changed: release the previous journey, then claim the new one.
      this.releaseStagedFigure();
      this.stagedFigureId = stagedId;
      const journey = stagedId ? getFigureJourney(stagedId) : undefined;
      if (stagedId && journey) {
        this.stagedJourney = journey;
        this.figureStagedAtMs = sinceMs ?? tMs; // span start, for mid-span resume
        this.attachFigureDetachListener(stagedId);
        // Force a reset()+forward-sweep from frame 0 to the current target
        // (claiming the figure stands its self-play down via `driven`). In
        // stepped mode the target is the step's endMs; in continuous mode it's
        // the offset into the span. +Infinity never equals a finite target, so
        // the claim always resets and sweeps regardless of mode.
        this.figureLastSeekMs = Number.POSITIVE_INFINITY;
        this.advanceStagedFigure(tMs, step);
      }
      return;
    }

    // Same figure still staged — advance it from the audio clock (or hold at
    // its step, in stepped mode).
    if (!this.stagedJourney || this.figureDetached) return; // empty stage / no journey / reader took over
    this.advanceStagedFigure(tMs, step);
  }

  // Advance the staged journey for this tick, in one of two modes (methodology.md → "Live figure driving")
  // chosen by whether the active mark carries a `step` cue for the staged
  // figure:
  //   - Stepped (step != null): target = `steps[label].endMs` — play *through*
  //     the labeled segment and HOLD on its final frame (no loop). A missing
  //     label degrades gracefully (warn + hold the current frame). An early-out
  //     skips re-seeking when the target hasn't moved (a still-active step).
  //   - Continuous (step == null): free-run by the audio clock, looping while
  //     the staged span outlasts one play-through (`elapsed % durationMs`).
  // Both apply the forward-only seek plan (small steps; reset()+replay on a wrap
  // or a backward scrub) — see `figureSeekPlan`.
  private advanceStagedFigure(tMs: Milliseconds, step: string | null) {
    const journey = this.stagedJourney;
    if (!journey) return;
    const dur = journey.durationMs;
    if (dur <= 0) return;

    let target: number;
    if (step !== null) {
      // Stepped mode: drive to the labeled step's endMs and hold.
      const found = journey.steps.find((s) => s.label === step);
      if (!found) {
        // Author typo / renamed label: don't throw and don't free-run — hold
        // the current frame so a missing label degrades gracefully (§4.2).
        console.warn(
          `Narration step "${step}" not found in figure "${this.stagedFigureId}" journey — holding current frame`,
        );
        return;
      }
      target = found.endMs;
      // Idempotent hold: the same step still active → target unchanged → skip
      // the (no-op) re-seek (§4.3). +Infinity (a fresh claim) never matches.
      if (target === this.figureLastSeekMs) return;
    } else {
      // Continuous mode (methodology.md → "Live figure driving"): free-run + loop by the audio clock.
      const elapsed = Math.max(0, tMs - this.figureStagedAtMs);
      target = elapsed % dur;
    }

    const plan = figureSeekPlan(this.figureLastSeekMs, target, FigureDriver.FIGURE_STEP_MS);
    if (plan.reset) journey.reset();
    for (const p of plan.seeks) journey.seek(p);
    this.figureLastSeekMs = target;
  }

  // Release the currently-staged journey: drop the detach listener and forget
  // the journey. The figure HOLDS its last frame (we don't re-`reset()` it) —
  // an empty stage on the live page just means "stop driving," and the figure
  // stays in the DOM showing where it was left.
  releaseStagedFigure() {
    this.detachFigureDetachListener();
    this.stagedFigureId = null;
    this.stagedJourney = null;
    this.figureDetached = false;
    this.figureLastSeekMs = 0;
  }

  // §6: clicking a control inside the staged figure detaches the driver so the
  // figure's own handlers own its state (the driver stops seeking it). The
  // trigger is a concrete event set — a click landing on an interactive control
  // (button/tab/input/link), not hover or scroll.
  private attachFigureDetachListener(figureId: string) {
    const el = document.getElementById(figureId);
    if (!el) return;
    const handler = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("button, [role='tab'], input, select, a")) {
        this.figureDetached = true;
      }
    };
    el.addEventListener("click", handler);
    this.figureDetachEl = el;
    this.figureDetachHandler = handler;
  }

  private detachFigureDetachListener() {
    if (this.figureDetachEl && this.figureDetachHandler) {
      this.figureDetachEl.removeEventListener("click", this.figureDetachHandler);
    }
    this.figureDetachEl = null;
    this.figureDetachHandler = null;
  }
}
