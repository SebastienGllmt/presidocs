// Integration check for the video renderer's per-step held-frame extraction
// (methodology.md → "Video export"). The pure pieces are unit-tested in render-video.test.ts
// (`heldFrameIndex`, `deriveFigureOccurrences` step schedule); what THAT can't
// cover is the one ffmpeg-dependent step: does `extractHeldFrame` actually pull
// the clip frame that `heldFrameIndex` names? An off-by-one in the
// `select=eq(n,idx)` filter would silently hold the wrong frame.
//
// We build a synthetic clip whose frame N is a solid color with red = N·20 — so
// the extracted frame's top-left red channel reports which frame ffmpeg pulled.
// Driving to a later journey position must extract a later (brighter) frame, the
// last step (`endMs===durationMs`) must land on the final frame, and the same
// position must extract byte-identically. This is the automatable core of the
// "stepped render" golden; the full real-post render stays the manual sanity
// step (it needs GPU-generated audio/manifest + a ~min render — see methodology.md → "Video export").
//
// In the e2e tier (needs ffmpeg), excluded from the default `bun test` glob; run
// explicitly: `bun test ./e2e/videoStepRender.e2e.ts`. Skips if ffmpeg is absent.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractHeldFrame, heldFrameIndex } from "../generate/render-video.ts";

const ffmpeg = Bun.which("ffmpeg");
const FPS = 30;
const DUR_MS = 400; // → clip frames 0..ceil(0.4·30)=12 (13 frames), red = N·20 ≤ 240

let dir: string;
let clip: string;

beforeAll(async () => {
  if (!ffmpeg) return;
  dir = await mkdtemp(join(tmpdir(), "presidocs-stepframe-"));
  clip = join(dir, "synthetic.mp4");
  // Frame N → solid RGB(N·20, 0, 0). `geq`'s `N` is the 0-based frame index.
  // Encoded exactly like a real figure clip (libx264 / yuv420p / -r fps).
  const proc = Bun.spawn(
    [
      "ffmpeg", "-y",
      "-f", "lavfi", "-i", `color=c=black:s=16x16:r=${FPS}`,
      "-vf", "geq=r='N*20':g=0:b=0",
      "-frames:v", "13",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(FPS),
      clip,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  if ((await proc.exited) !== 0) throw new Error("synthetic clip build failed");
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

// Read the top-left pixel's red channel from a PNG (via ffmpeg, no PNG lib).
async function topLeftRed(png: string): Promise<number> {
  const proc = Bun.spawn(
    ["ffmpeg", "-y", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { stdout: "pipe", stderr: "ignore" },
  );
  const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  if (bytes.length < 3) throw new Error(`could not read pixels from ${png}`);
  return bytes[0]!; // R of the first pixel
}

async function extractRedAt(posMs: number): Promise<number> {
  const out = join(dir, `held-${posMs}.png`);
  await extractHeldFrame({ file: clip, fps: FPS, durationMs: DUR_MS }, posMs, out);
  return topLeftRed(out);
}

test.skipIf(!ffmpeg)(
  "extractHeldFrame pulls the clip frame heldFrameIndex names (position → frame mapping)",
  async () => {
    // Sanity on the index math we're about to verify against (frame N ⇒ red N·20).
    expect(heldFrameIndex(0, FPS, DUR_MS)).toBe(0); // → red 0
    expect(heldFrameIndex(200, FPS, DUR_MS)).toBe(6); // → red ~120
    expect(heldFrameIndex(DUR_MS, FPS, DUR_MS)).toBe(12); // last step → final frame, red ~240

    const red0 = await extractRedAt(0);
    const redMid = await extractRedAt(200);
    const redEnd = await extractRedAt(DUR_MS);

    // Later journey position → later (brighter) frame: the held frame advances
    // forward with the step, never snapping to the wrong frame.
    expect(red0, "frame 0 is darkest").toBeLessThan(redMid);
    expect(redMid, "mid frame is between").toBeLessThan(redEnd);

    // Frame identity (tolerant of the yuv420p round-trip on a solid field): each
    // lands on its predicted frame, the last step on the final frame (~240).
    expect(Math.abs(red0 - 0)).toBeLessThanOrEqual(20);
    expect(Math.abs(redMid - 120)).toBeLessThanOrEqual(20);
    expect(Math.abs(redEnd - 240)).toBeLessThanOrEqual(20);

    // Deterministic: the same position extracts the byte-identical frame.
    const a = join(dir, "det-a.png");
    const b = join(dir, "det-b.png");
    await extractHeldFrame({ file: clip, fps: FPS, durationMs: DUR_MS }, 100, a);
    await extractHeldFrame({ file: clip, fps: FPS, durationMs: DUR_MS }, 100, b);
    expect(Buffer.from(await Bun.file(a).arrayBuffer())).toEqual(
      Buffer.from(await Bun.file(b).arrayBuffer()),
    );
  },
);
