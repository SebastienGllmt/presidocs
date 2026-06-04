// Figure animation contract — the `FigureJourney`. See proposals/43.
//
// A figure (a content-repo DOM/JS visualization, GSAP-driven) exposes its
// animation as a PURE FORWARD RENDERER plus a label/segment map. The engine's
// consumers — the offline video renderer today, the in-page narrator later —
// drive it by owning a clock and calling `seek()`. There is deliberately NO
// play/pause/onComplete on the figure: "transport" (play, loop, hold/pause,
// advance-to-step) is a *driver* concern (a driver advancing or not advancing
// its clock), not the figure's. This keeps figures dumb and uniform.
//
// Locked decisions (proposals/43 §3, §9):
//  - Forward-seek, not random-access. `seek()` is called monotonically forward
//    between `reset()`s (a loop / "go to an earlier point" is reset()+forward).
//    Advancement must be in steps small enough to cross every timeline callback;
//    coarse jumps are NOT supported (they'd skip GSAP `.call()` state). This is
//    why discrete state via `.call()` is fine — and why we did NOT name `seek`
//    after WAAP `currentTime` / Lottie `goToAndStop`, which imply random access.
//  - `steps` are projected from the figure's GSAP timeline labels (one source of
//    truth) — see `stepsFromLabels`.
//
// Discovery is a window registry keyed by the figure's element id (= its
// narration mark name), reachable from in-page code and from Playwright's
// `page.evaluate` (the capture driver).

export interface FigureStep {
  /** Author-assigned, stable. The join-point for narration-driven stepping. */
  readonly label: string;
  /** Segment bounds within the journey, in ms. `steps[0].startMs === 0`; the
   *  last step's `endMs === durationMs`; segments are contiguous & increasing. */
  readonly startMs: number;
  readonly endMs: number;
}

export interface FigureJourney {
  /** Length of one play-through, in ms (= end of the last step). */
  readonly durationMs: number;
  /** Ordered, labeled segments (projected from GSAP labels via stepsFromLabels). */
  readonly steps: ReadonlyArray<FigureStep>;
  /** Snap to the first frame (time zero). */
  reset(): void;
  /** Render the frame at absolute journey time `ms`. Forward-only between
   *  reset()s; need not render correctly from a cold coarse jump. */
  seek(ms: number): void;
}

const REGISTRY_KEY = "__presidocsFigures";
const READY_EVENT = "presidocs:figure-ready";

type Registry = Map<string, FigureJourney>;

function registry(): Registry {
  const w = window as unknown as Record<string, Registry | undefined>;
  return (w[REGISTRY_KEY] ??= new Map());
}

/** A figure registers its journey under its element id. Fires
 *  `presidocs:figure-ready` (detail.id) so a waiting driver needn't poll. */
export function registerFigureJourney(id: string, journey: FigureJourney): void {
  registry().set(id, journey);
  window.dispatchEvent(new CustomEvent(READY_EVENT, { detail: { id } }));
}

export function getFigureJourney(id: string): FigureJourney | undefined {
  return registry().get(id);
}

/** Enumerate registered journeys (à la `document.getAnimations()`), so a driver
 *  or the conformance test needn't be handed an id list. */
export function listFigureJourneys(): string[] {
  return [...registry().keys()];
}

/**
 * Project a GSAP timeline's labels into the `steps` shape. Kept dependency-free:
 * pass `timeline.labels` (a `{ label: seconds }` record) and `timeline.duration()`
 * (seconds). Labels are sorted, paired into contiguous `{startMs,endMs}` segments,
 * and a synthetic first step is prepended if no label sits at 0. A timeline with
 * no labels yields a single `main` step spanning the whole duration.
 */
export function stepsFromLabels(
  labels: Record<string, number>,
  durationSec: number,
): FigureStep[] {
  // Do NOT round: the last step's endMs must equal the registered
  // durationMs (`duration() * 1000`), which is generally fractional.
  const durMs = durationSec * 1000;
  const sorted = Object.entries(labels)
    .map(([label, sec]) => ({ label, startMs: sec * 1000 }))
    .sort((a, b) => a.startMs - b.startMs)
    // Collapse labels at the same time (keep the first) so two labels at one
    // instant can't produce a zero-length step.
    .filter((s, i, a) => i === 0 || s.startMs !== a[i - 1]!.startMs);
  if (sorted.length === 0) return [{ label: "main", startMs: 0, endMs: durMs }];
  if (sorted[0]!.startMs > 0) sorted.unshift({ label: "start", startMs: 0 });
  return sorted.map((s, i) => ({
    label: s.label,
    startMs: s.startMs,
    endMs: sorted[i + 1]?.startMs ?? durMs,
  }));
}

export const FIGURE_REGISTRY_KEY = REGISTRY_KEY;
export const FIGURE_READY_EVENT = READY_EVENT;
