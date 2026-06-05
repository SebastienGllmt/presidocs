// Capture real, enhanced post figures for the video stage, in a real browser.
//
// A figure is a DOM/JS component (GSAP, MutationObserver, sometimes canvas) —
// satori/resvg cannot run it; its static-SVG fallback rasterizes to empty boxes
// (no fonts/CSS context). So we render the *real* figure: boot the content
// repo's dev server, load the post, let each <figure> enhance, and capture it.
// Reuses the e2e harness (system Chrome + dev server). OPTIONAL build dep —
// render-video.ts dynamic-imports this only when a figure appears in the span.
//
// Two modes per figure:
//   - clip:  the figure registered a FigureJourney (engine
//            contract). We scrub its paused timeline frame-by-frame over one
//            natural play-through and assemble a short mp4 — deterministic
//            (seek, not wall-clock), and looped to fill its span by the
//            compositor.
//   - still: no controller (figure not yet converted). One settled screenshot;
//            the compositor shows it as a static frame.

import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { startBlogServer, launchChrome } from "../e2e/harness.ts";
import { CAPTURE_DEFAULTS } from "./capture-defaults.ts";

/** A labeled step of a figure's journey (projected from GSAP labels), as the
 *  capture reads it from the registry. The renderer maps a `step=` cue's label
 *  to `endMs` and holds the figure there (proposal 50 §6). */
export type CapturedStep = { label: string; startMs: number; endMs: number };

export type FigureShot =
  | { kind: "still"; file: string }
  | { kind: "clip"; file: string; durationMs: number; fps: number; steps: CapturedStep[] };

export type FigureCaptureOptions = {
  /** ms to wait after scrolling a figure in, for enhancement + controller registration. */
  settleMs?: number;
  /** Frames per second for captured animation clips. */
  fps?: number;
};

export async function captureFigures(
  contentRoot: string,
  slug: string,
  ids: readonly string[],
  outDir: string,
  opts: FigureCaptureOptions = {},
): Promise<Map<string, FigureShot>> {
  const settleMs = opts.settleMs ?? CAPTURE_DEFAULTS.settleMs;
  // Match the video's framerate: a low figure-clip fps makes eased motion read
  // as choppy/confusing even when the video itself is 30fps.
  const fps = opts.fps ?? CAPTURE_DEFAULTS.fps;
  const out = new Map<string, FigureShot>();
  if (ids.length === 0) return out;

  process.env.PRESIDOCS_E2E_BLOG = contentRoot; // pin the harness to this repo

  const server = await startBlogServer();
  const browser = await launchChrome();
  try {
    const page = await browser.newPage({
      viewport: { width: CAPTURE_DEFAULTS.viewportW, height: CAPTURE_DEFAULTS.viewportH },
      deviceScaleFactor: CAPTURE_DEFAULTS.deviceScaleFactor,
    });
    await page.goto(`${server.baseURL}/posts/${slug}`, { waitUntil: "load", timeout: 30_000 });

    // Hide the fixed/sticky page chrome (the narration player dock + chapter
    // strip) so it can't bleed into a figure's element screenshot when the
    // figure's bounding box reaches the dock at the viewport bottom. These are
    // page furniture, never part of a figure, so hiding them changes nothing in
    // the captured figure itself. (Capture-logic changes like this invalidate
    // the figure cache via render-video.ts `figureEnvHash`.)
    await page.addStyleTag({ content: ".narrate-dock, .chapter-strip { display: none !important; }" });

    for (const id of ids) {
      const fig = page.locator(`#${cssEscape(id)}`);
      if ((await fig.count()) === 0) continue;
      try {
        await fig.scrollIntoViewIfNeeded({ timeout: 5_000 });
        await page.waitForTimeout(settleMs); // enhancement + controller registration

        const info: { durationMs: number; steps: CapturedStep[] } | null = await page.evaluate((figId) => {
          const j = (window as unknown as {
            __presidocsFigures?: Map<string, { durationMs: number; steps: CapturedStep[] }>;
          }).__presidocsFigures?.get(figId);
          return j ? { durationMs: j.durationMs, steps: j.steps } : null;
        }, id);

        if (info && info.durationMs > 0) {
          out.set(id, await captureClip(page, id, info.durationMs, fps, outDir, info.steps));
        } else {
          const file = join(outDir, `fig-${id}.png`);
          await fig.screenshot({ path: file });
          out.set(id, { kind: "still", file });
        }
      } catch (e) {
        console.warn(`  figure "${id}" capture failed: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  } finally {
    await browser.close();
    await server.stop();
  }
  return out;
}

// Scrub the figure's controller timeline deterministically and assemble a clip.
async function captureClip(
  // deliberately untyped Playwright Page to avoid a hard type dep here
  page: { evaluate: Function; locator: Function },
  id: string,
  durationMs: number,
  fps: number,
  outDir: string,
  steps: CapturedStep[],
): Promise<FigureShot> {
  const framesDir = join(outDir, `frames-${id}`);
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });

  const fig = page.locator(`#${cssEscape(id)}`);
  await page.evaluate((figId: string) => {
    (window as unknown as { __presidocsFigures: Map<string, { reset(): void }> }).__presidocsFigures
      .get(figId)!
      .reset();
  }, id);

  // Sample i = 0..n inclusive so the final frame lands exactly on durationMs —
  // otherwise a state set right at the end (e.g. a `.call()` on the last frame)
  // is dropped and the clip ends a frame short.
  const n = Math.max(1, Math.ceil((durationMs / 1000) * fps));
  for (let i = 0; i <= n; i++) {
    const t = Math.min((i / fps) * 1000, durationMs);
    await page.evaluate(
      ([figId, ms]: [string, number]) => {
        (window as unknown as { __presidocsFigures: Map<string, { seek(ms: number): void }> })
          .__presidocsFigures.get(figId)!
          .seek(ms);
      },
      [id, t] as [string, number],
    );
    await fig.screenshot({ path: join(framesDir, `f${String(i).padStart(5, "0")}.png`) });
  }

  const file = join(outDir, `fig-${id}.mp4`);
  const proc = Bun.spawn(
    [
      "ffmpeg", "-y",
      "-framerate", String(fps),
      "-i", join(framesDir, "f%05d.png"),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(fps),
      file,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  if ((await proc.exited) !== 0) throw new Error(`ffmpeg clip assembly failed for ${id}`);
  return { kind: "clip", file, durationMs, fps, steps };
}

// Minimal CSS.escape for the simple ids posts use (alnum + hyphen + underscore).
function cssEscape(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
