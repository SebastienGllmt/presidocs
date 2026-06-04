// Conformance test for the FigureJourney contract (proposals/43).
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
