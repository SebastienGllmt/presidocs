// Conformance test for the FigureJourney contract (methodology.md → "Animated figures" → "The FigureJourney contract").
//
// Loads a real post in Chromium and asserts that every figure which registered
// a journey actually satisfies the contract: a well-formed `steps` map, and a
// forward-seek render that produces distinct frames and a deterministic,
// idempotent end. This is the gate a converted figure must pass to be
// "video-ready" — and the regression guard as figures are converted. It checks
// EVERY registered journey, so it auto-covers new figures with no edits.
//
// Like the other *.e2e.ts files, this is excluded from the default `bun test`
// glob; run it explicitly: `bun test ./e2e/figureJourney.e2e.ts`.

import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchChrome, startBlogServer, type BlogServer } from "./harness.ts";

let browser: Browser;
let server: BlogServer;

beforeAll(async () => {
  [browser, server] = await Promise.all([launchChrome(), startBlogServer()]);
});

afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

// offer-files carries the in-use figures; _figjourneys is a dev-only fixture
// (build-html skips `_`-prefixed entries, so it never deploys) that embeds the
// two figures no published post uses — offerVolume (data-gated) and
// hashAvalanche — so CI exercises them too.
const POSTS = ["offer-files", "_figjourneys"];

async function openPost(page: Page, slug: string): Promise<void> {
  await page.goto(`${server.baseURL}/posts/${slug}`, { waitUntil: "load", timeout: 30_000 });
  // Figures register their journey on module init; wait until at least one is in.
  await page.waitForFunction(
    () => ((window as unknown as { __presidocsFigures?: Map<string, unknown> }).__presidocsFigures?.size ?? 0) > 0,
    { timeout: 10_000 },
  );
  // Some figures register asynchronously (e.g. hashAvalanche after two SHA-256s);
  // give them a beat so the registry is complete before we enumerate it.
  await page.waitForTimeout(600);
}

test("registered figure journeys conform to the contract", async () => {
  const page = await browser.newPage({ viewport: { width: 1366, height: 1200 } });
  try {
    for (const slug of POSTS) {
    await openPost(page, slug);

    const ids: string[] = await page.evaluate(() => [
      ...(window as unknown as { __presidocsFigures: Map<string, unknown> }).__presidocsFigures.keys(),
    ]);
    expect(ids.length, `${slug}: at least one figure registers a journey`).toBeGreaterThan(0);
    if (slug === "_figjourneys") {
      // The fixture exists precisely to cover these two; a data/bundling failure
      // would otherwise silently leave them unregistered and the test green.
      expect(ids, "fixture registers both diagram + volume-figure").toEqual(
        expect.arrayContaining(["diagram", "volume-figure"]),
      );
    }

    for (const id of ids) {
      // --- structural: durationMs + contiguous, labeled, increasing steps ---
      const shape = await page.evaluate((figId) => {
        const j = (window as any).__presidocsFigures.get(figId);
        return { durationMs: j.durationMs, steps: j.steps };
      }, id);

      expect(shape.durationMs, `${id}: durationMs > 0`).toBeGreaterThan(0);
      expect(shape.steps.length, `${id}: has at least one step`).toBeGreaterThan(0);
      expect(shape.steps[0].startMs, `${id}: first step starts at 0`).toBe(0);
      expect(shape.steps.at(-1).endMs, `${id}: last step ends at durationMs`).toBe(shape.durationMs);
      for (let i = 0; i < shape.steps.length; i++) {
        const s = shape.steps[i];
        expect(typeof s.label, `${id}: step ${i} has a label`).toBe("string");
        expect(s.endMs, `${id}: step ${i} end > start`).toBeGreaterThan(s.startMs);
        if (i > 0) {
          expect(s.startMs, `${id}: step ${i} is contiguous with ${i - 1}`).toBe(shape.steps[i - 1].endMs);
        }
      }

      // --- integrity: reset() must NOT destroy a journey that already exists
      // before any reset. `gsap.killTweensOf(sharedEls)` reaches INTO a paused
      // timeline and kills the journey's own tweens — so a build-once journey
      // that killTweensOf's its shared elements without rebuilding is silently
      // dead after the first reset (text still changes via .call(), positions
      // freeze), yet stays deterministic and passes the behavioral check below.
      // This runs FIRST, on the truly-pristine journey (the behavioral check
      // resets repeatedly and would mask the damage). Rebuild-on-reset figures
      // have no pre-reset journey (seek is a no-op until reset builds it), so
      // their pristine pass shows no animation and is skipped here. ---
      const integrity = await page.evaluate((figId) => {
        const j = (window as any).__presidocsFigures.get(figId);
        const el = document.getElementById(figId)!;
        const step = 1000 / 30;
        const pass = () => {
          const frames: string[] = [];
          const n = Math.max(1, Math.ceil(j.durationMs / step));
          for (let i = 0; i <= n; i++) {
            j.seek(Math.min(i * step, j.durationMs));
            frames.push(el.outerHTML);
          }
          return frames;
        };
        const pristine = pass(); // NO reset() first — the journey as registered
        j.reset();
        const afterReset = pass();
        return {
          pristineCount: new Set(pristine).size,
          afterResetCount: new Set(afterReset).size,
        };
      }, id);
      // reset() must not collapse the journey's animation. The marketMaker bug
      // froze ~70% of frames; tolerate small build-residue noise (±a few frames)
      // with a 0.6 ratio floor so we flag real loss, not a pinning quirk.
      if (integrity.pristineCount > 4) {
        expect(
          integrity.afterResetCount,
          `${id}: reset() collapsed the journey's animation (killTweensOf reaches into the paused timeline and kills the journey's own tweens — rebuild the journey in reset())`,
        ).toBeGreaterThanOrEqual(Math.ceil(integrity.pristineCount * 0.6));
      }

      // --- behavioral: forward seek renders distinct frames; end is
      // deterministic across runs and idempotent on re-seek (no coarse jump,
      // per the forward-only contract). ---
      const behave = await page.evaluate((figId) => {
        const j = (window as any).__presidocsFigures.get(figId);
        const el = document.getElementById(figId)!;
        const fps = 30;
        const step = 1000 / fps;
        const forward = () => {
          j.reset();
          const frames = new Set<string>();
          const n = Math.max(1, Math.ceil(j.durationMs / step));
          for (let i = 0; i <= n; i++) {
            j.seek(Math.min(i * step, j.durationMs)); // last sample lands exactly on durationMs
            frames.add(el.outerHTML);
          }
          return { count: frames.size, end: el.outerHTML };
        };
        const run1 = forward();
        const reseek = (() => {
          j.seek(j.durationMs);
          return el.outerHTML;
        })();
        const run2 = forward();
        return {
          distinctFrames: run1.count,
          idempotentReseek: reseek === run1.end,
          deterministicEnd: run2.end === run1.end,
        };
      }, id);

      // A journey must actually change something across its span (≥2 distinct
      // frames). Discrete tab/step tours legitimately have only a few frames —
      // one per state — so this is intentionally a low bar; the determinism
      // checks below are the load-bearing ones.
      expect(behave.distinctFrames, `${id}: forward seek produces distinct frames`).toBeGreaterThan(1);
      expect(behave.idempotentReseek, `${id}: re-seeking the end frame is stable`).toBe(true);
      expect(behave.deterministicEnd, `${id}: the end frame is deterministic across runs`).toBe(true);
    }
    }
  } finally {
    await page.close();
  }
}, 120_000);

// See the `figure-journey` skill — rule 7 (the `driven` guard): once a DRIVER has claimed a figure (the narration/video
// driver calls `reset()`), the figure's own live triggers — scroll-into-view
// (IntersectionObserver) and the `.narration-active` class toggle
// (MutationObserver) — must NO-OP. This is the regression guard for the bug
// behind the original offerMerge issue (the `figure-journey` skill — rule 7): a figure with a
// missing/ineffective `driven` guard would let its self-play mutate the DOM and
// race the driver's scrubbing. The structural/determinism test above never
// fires a live trigger, so it can't see this — this test does.
//
// The check: after `reset()`, fire both triggers and let any erroneous live
// tween / IO callback / loop scheduler run, then assert the journey is
// untouched — its frame-0 render is byte-identical to a clean claim (no
// live-tween inline-style residue), and a forward pass still lands on the same
// deterministic end frame. A live path that ignored `driven` would leave inline
// styles on elements the journey doesn't touch, diverging frame 0.
test("a claimed figure ignores its live triggers (driven guard holds)", async () => {
  const page = await browser.newPage({ viewport: { width: 1366, height: 1200 } });
  try {
    await openPost(page, "offer-files");
    const ids: string[] = await page.evaluate(() => [
      ...(window as unknown as { __presidocsFigures: Map<string, unknown> }).__presidocsFigures.keys(),
    ]);
    expect(ids.length, "offer-files registers figure journeys").toBeGreaterThan(0);
    // merge-figure is the original offending figure — make sure it's covered.
    expect(ids, "offer-files embeds the merge figure").toContain("merge-figure");

    for (const id of ids) {
      const result = await page.evaluate(async (figId) => {
        const j = (window as any).__presidocsFigures.get(figId);
        const el = document.getElementById(figId);
        if (!el) return { skipped: true as const };
        const step = 1000 / 30;
        const n = Math.max(1, Math.ceil(j.durationMs / step));
        const pass = (): string => {
          for (let i = 0; i <= n; i++) j.seek(Math.min(i * step, j.durationMs));
          return el.outerHTML;
        };
        // Measure (frame 0, end) for a claimed figure, optionally firing its
        // live triggers between the claim and the capture. Both runs share an
        // IDENTICAL history (a warm-up forward pass then a fresh claim) so any
        // `immediateRender:false` inline residue is the same in both — the ONLY
        // variable is whether the live triggers fired. A live path that ignored
        // `driven` would mutate DOM the journey doesn't control (e.g. an intro
        // stagger on elements outside the tour), diverging frame 0.
        const measure = async (fire: boolean) => {
          j.reset();
          pass(); // warm-up: normalize immediateRender:false residue
          j.reset(); // claim fresh — driven guard is now set
          if (fire) {
            el.scrollIntoView();
            el.classList.remove("narration-active");
            el.classList.add("narration-active"); // false→true edge the MutationObserver watches
            await new Promise((r) => setTimeout(r, 500)); // let any rogue tween / IO / loop run
            el.classList.remove("narration-active"); // compare rendered state, not the class attr
          }
          j.reset();
          j.seek(0);
          const frame0 = el.outerHTML;
          const end = pass();
          return { frame0, end };
        };
        const base = await measure(false);
        const trig = await measure(true);
        return {
          skipped: false as const,
          frame0Match: trig.frame0 === base.frame0,
          endMatch: trig.end === base.end,
        };
      }, id);

      if (result.skipped) continue;
      expect(
        result.frame0Match,
        `${id}: live triggers after reset() left no residue — the figure's self-play (IO/narration-active) must stand down once a driver claims it (missing/ineffective \`driven\` guard?)`,
      ).toBe(true);
      expect(
        result.endMatch,
        `${id}: forward-pass end frame stays deterministic after live triggers fire`,
      ).toBe(true);
    }
  } finally {
    await page.close();
  }
}, 120_000);

// methodology.md → "Live figure driving" — the per-step (slideshow) driving test bed. `lifecycle-figure`
// (offer-files) is annotated with `step=` cues (semantic labels created…settled,
// renamed from the old positional step-0…step-N). This exercises the live
// narrator's STEPPED mode (`advanceStagedFigure` with an active step) the way
// the existing tests exercise the journey: driving the figure DIRECTLY via
// page.evaluate (real audio-synced playback can't run headless — Shikwasa's
// detached <audio> + the dev server 404ing the WAV — so that is the manual
// sanity step). We replicate exactly what the driver's stepped branch does:
// target = steps[label].endMs, reached forward-only (reset()+small-step sweep,
// the figureSeekPlan discipline), then HOLD — and assert the three properties
// the stepped mode promises: it holds at endMs (re-seek is idempotent), it
// advances forward across cues, and the held frame is a pure function of the
// active step (so scrubbing/replay is deterministic, §4.3).
test("lifecycle-figure: stepped driving holds at steps[label].endMs and advances forward-only", async () => {
  const page = await browser.newPage({ viewport: { width: 1366, height: 1200 } });
  try {
    await openPost(page, "offer-files");

    // The semantic labels the annotation renamed to (offerLifecycle.ts §7.3).
    const LABELS = ["created", "encoded", "posted", "indexed", "book", "settled"];

    const out = await page.evaluate((labels) => {
      const j = (window as any).__presidocsFigures.get("lifecycle-figure");
      const el = document.getElementById("lifecycle-figure")!;
      const STEP_MS = 1000 / 30; // Narrator.FIGURE_STEP_MS

      const steps: { label: string; startMs: number; endMs: number }[] = j.steps;
      const stepLabels = steps.map((s) => s.label);

      const sweepTo = (target: number) => {
        for (let p = STEP_MS; p < target; p += STEP_MS) j.seek(p);
        j.seek(target); // land exactly on the target, no coarse jump
      };
      // Drive to a label exactly as advanceStagedFigure's stepped branch does:
      // target = steps[label].endMs, reached by reset()+forward small-step sweep
      // (a fresh claim path — forward-only). A full warm-up sweep FIRST
      // normalizes GSAP's `immediateRender:false` inline-style residue across
      // every stage (else a label early in the timeline leaves later stages
      // un-touched, and the held frame would depend on prior history rather than
      // the target — the documented e2e gotcha). After warm-up the held frame is
      // a pure function of the active step, which is the property §4.3 promises.
      const driveTo = (label: string): string => {
        const target = steps.find((s) => s.label === label)!.endMs;
        j.reset();
        sweepTo(j.durationMs); // warm-up: touch every stage once
        j.reset();
        sweepTo(target); // claim + forward-only sweep to the step, then hold
        return el.outerHTML;
      };

      // 1) Hold idempotency: re-seeking the SAME step's endMs (the driver's
      //    `target === figureLastSeekMs` early-out would skip it entirely) must
      //    not change the rendered frame.
      const held = driveTo("posted");
      j.seek(steps.find((s) => s.label === "posted")!.endMs);
      const heldAgain = el.outerHTML;

      // 2) Forward advance across cues + determinism: walk all labels in order,
      //    twice, capturing the held frame at each. The two passes must match
      //    (held frame is a pure function of the active step — §4.3 scrub
      //    robustness), and consecutive labels must differ (the figure actually
      //    steps).
      const pass = () => labels.map((l) => driveTo(l));
      const run1 = pass();
      const run2 = pass();

      // 3) Forward-only replay: reaching an EARLIER label after a LATER one
      //    (the driver reset()s + replays) lands on the same frame as reaching
      //    it fresh — never a stale later frame.
      driveTo("settled");
      const backToCreated = driveTo("created");

      return {
        stepLabels,
        durationMs: j.durationMs,
        lastEndMs: steps[steps.length - 1]!.endMs,
        holdIdempotent: heldAgain === held,
        run1,
        run2,
        backToCreated,
        freshCreated: run1[0]!,
      };
    }, LABELS);

    // The rename landed: the journey exposes the semantic labels (not step-0…N).
    expect(out.stepLabels, "lifecycle-figure exposes the semantic step labels").toEqual(
      expect.arrayContaining(LABELS),
    );
    // Last step ends at durationMs (so driving to "settled" rests on the end frame).
    expect(out.lastEndMs, "last step endMs === durationMs").toBe(out.durationMs);

    // 1) Holding at a step's endMs is idempotent (the early-out is safe).
    expect(out.holdIdempotent, "re-driving the same step holds the frame").toBe(true);

    // 2) Determinism across passes + actual forward motion between cues.
    expect(out.run2, "held frame at each step is deterministic across passes").toEqual(out.run1);
    for (let i = 1; i < out.run1.length; i++) {
      expect(
        out.run1[i]!,
        `stepping from "${LABELS[i - 1]}" to "${LABELS[i]}" advances the figure`,
      ).not.toBe(out.run1[i - 1]!);
    }

    // 3) Forward-only: replaying back to an earlier label is reset()+replay, so
    //    it matches the fresh render of that label (not the later frame).
    expect(
      out.backToCreated,
      "driving back to an earlier step replays forward to the same frame",
    ).toBe(out.freshCreated);
  } finally {
    await page.close();
  }
}, 120_000);

// methodology.md → "Live figure driving" — stepped driving is **scrub-correct**: the figure's state is
// a pure function of the active step at the playhead, not of how you got there.
// Seeking the audio anywhere (forward, back, or jumping around) lands the figure
// on that step's frame, via the driver's forward-only discipline (reset()+replay
// when the target is behind). This test drives a *scrambled* order of step
// targets through the EXACT `figureSeekPlan` logic `advanceStagedFigure` uses,
// and asserts each landing matches the state reached by a fresh forward drive.
//
// It compares the figure's MEANINGFUL slideshow state — which stages are lit,
// the connector fills, and the caption — NOT `outerHTML`: GSAP's
// `immediateRender:false` leaves per-stage inline transform residue that depends
// on which frames were visited and is irrelevant to what's displayed; comparing
// it would flag false scrub "mismatches".
test("lifecycle-figure: stepped driving is scrub-correct (state is a pure function of the active step)", async () => {
  const page = await browser.newPage({ viewport: { width: 1366, height: 1200 } });
  try {
    await openPost(page, "offer-files");

    const out = await page.evaluate(() => {
      const j = (window as any).__presidocsFigures.get("lifecycle-figure");
      const el = document.getElementById("lifecycle-figure")!;
      const STEP_MS = 1000 / 30; // Narrator.FIGURE_STEP_MS
      const steps: { label: string; startMs: number; endMs: number }[] = j.steps;
      const endMsOf = (l: string) => steps.find((s) => s.label === l)!.endMs;

      // The displayed slideshow state, residue-free: lit stages + link fills +
      // caption. This is what the reader sees; transform residue is not.
      const stateSig = () =>
        JSON.stringify({
          lit: [...el.querySelectorAll(".stage")].map((s) => s.classList.contains("lit")),
          fills: [...el.querySelectorAll(".link-fill")].map((f) => (f as HTMLElement).style.width),
          caption: el.querySelector("[data-caption]")?.innerHTML ?? "",
        });

      // Reference: the state when each step is reached FRESH (reset + forward
      // sweep to its endMs) — the unambiguous "correct" frame for that step.
      const labels = steps.map((s) => s.label);
      const reference: Record<string, string> = {};
      for (const l of labels) {
        j.reset();
        const t = endMsOf(l);
        for (let p = STEP_MS; p < t; p += STEP_MS) j.seek(p);
        j.seek(t);
        reference[l] = stateSig();
      }

      // Stateful advance EXACTLY as advanceStagedFigure + figureSeekPlan: carry
      // `lastSeek`; reset()+replay-from-0 when the target is behind (a scrub
      // back), else forward small-steps. This IS the real scrub path.
      let lastSeek = Infinity; // a fresh claim forces the reset-and-sweep
      const advance = (target: number) => {
        const reset = target < lastSeek;
        const from = reset ? 0 : lastSeek;
        if (reset) j.reset();
        for (let p = from + STEP_MS; p < target; p += STEP_MS) j.seek(p);
        j.seek(target);
        lastSeek = target;
      };

      // A scramble — like a reader scrubbing the audio back and forth: forward,
      // jump to the end, jump back, hop around. Every landing must equal the
      // fresh reference for that step.
      const scramble = ["created", "posted", "settled", "encoded", "book", "created", "indexed", "settled"];
      const mismatches: string[] = [];
      for (const l of scramble) {
        advance(endMsOf(l));
        if (stateSig() !== reference[l]) mismatches.push(l);
      }
      return { scramble, mismatches, refCount: Object.keys(reference).length };
    });

    expect(out.refCount, "lifecycle-figure has steps to scrub across").toBeGreaterThan(1);
    expect(
      out.mismatches,
      `scrubbing to a step must land on that step's state regardless of history (mismatched: ${out.mismatches.join(", ") || "none"})`,
    ).toEqual([]);
  } finally {
    await page.close();
  }
}, 120_000);
