// Integration tests for `generate.ts` end-to-end. The unit tests in
// `audio-pipeline.test.ts` cover each pipeline op in isolation; this file
// covers the contract that *actually* matters at runtime: the manifest's
// chapter/mark times line up with positions in the emitted MP3.
//
// The drift bug that motivated this file was visible in unit tests
// (durationViaFfmpeg under-reports by up to ~46ms per WAV) but only became
// user-visible at integration scale: per-segment under-reports accumulated
// to ~5s of drift over a 30-minute post, so a chapter-mark seek landed in
// the previous chapter's audio. An end-to-end test that compares the
// manifest's claim against the real MP3 catches that whole class of bug
// regardless of which arithmetic in the pipeline drifts.

import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildSilence,
  createMp3AudioPipeline,
  durationViaFfmpeg,
  pcmDurationMs,
  type AudioFormat,
} from "./audio-pipeline.ts";
import { asMs } from "../shared/time.ts";

const ENGINE_ROOT = resolve(import.meta.dir, "..");
const GENERATE_SCRIPT = join(ENGINE_ROOT, "generate", "generate.ts");

// 3 chapters × multiple marks each, with enough segments that any per-
// segment duration drift compounds into a measurable gap by EOF. Using
// real words (not single-letter stubs) so the mock segment durations
// derived from word count are non-trivial; using paragraph breaks so the
// `continuesPrevious` flag varies between segments. The HTML scaffolding
// outside the `<script type="text/narration">` blocks is ignored by
// generate.ts (its HTMLRewriter selector only matches those scripts and
// `article[data-narration]`), so we keep it minimal.
const FIXTURE_HTML = `<!doctype html>
<html><head><title>test</title></head><body>
<article>
<script type="text/narration" data-chapter-id="intro" data-chapter-title="Intro">
<mark name="m-intro-1"/>
This is the first mark of the introduction chapter, several words long so the
mock duration is non-trivial.

<mark name="m-intro-2"/>
Here is a second mark with a paragraph break before it, which flips the
continues-previous flag for the following segment.

<mark name="m-intro-3"/>
And a third mark inside the same chapter to give us multi-segment math.
</script>

<script type="text/narration" data-chapter-id="middle" data-chapter-title="Middle">
<mark name="m-mid-1"/>
The middle chapter has its own marks; each segment is an independent
synthesis call in real mode and an independent silence buffer in mock mode.

<mark name="m-mid-2"/>
A second segment, again separated by a paragraph break so it counts as a
fresh start rather than a continuation.

<mark name="m-mid-3"/>
Third mark of the middle chapter, with enough words to make the mock
segment duration more than a token's worth.

<mark name="m-mid-4"/>
Fourth mark, still in the middle chapter; the more segments we have the
more any per-segment drift compounds.
</script>

<script type="text/narration" data-chapter-id="outro" data-chapter-title="Outro">
<mark name="m-outro-1"/>
The outro chapter is short but it still contributes a chapter join and a
segment gap to the cross-chapter arithmetic.

<mark name="m-outro-2"/>
And one final mark to close out the post.
</script>
</article>
</body></html>`;

async function runGenerate(projectRoot: string, postFile: string): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["bun", GENERATE_SCRIPT, postFile, "--mock"],
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr };
}

test("end-to-end: manifest chapter offsets line up with the emitted MP3", async () => {
  // Build a self-contained project root in a temp dir so generate.ts's
  // `resolve(dirname(htmlPath), "..")` lands somewhere we own. The script
  // writes `<projectRoot>/generated/<slug>/...`, which we inspect below.
  const root = await mkdtemp(join(tmpdir(), "presidocs-generate-test-"));
  try {
    await mkdir(join(root, "posts"), { recursive: true });
    const postFile = "posts/test-post.html";
    await Bun.write(join(root, postFile), FIXTURE_HTML);

    const { exitCode, stderr } = await runGenerate(root, postFile);
    if (exitCode !== 0) throw new Error(`generate.ts exited ${exitCode}:\n${stderr}`);

    const outDir = join(root, "generated", "test-post");
    const manifest = (await Bun.file(join(outDir, "manifest.json")).json()) as {
      audio: string;
      duration: number;
      chapters: { id: string; startTime: number; endTime: number }[];
      marks: { name: string; time: number; chapter: string }[];
    };

    // `manifest.audio` is a site-absolute path like
    // `/generated/test-post/full.<hash>.mp3`; resolve it under the project
    // root we just built. Read the bytes and ask ffmpeg for the real
    // duration of the file the player will actually load.
    const mp3Path = join(root, manifest.audio);
    const mp3 = new Uint8Array(await Bun.file(mp3Path).arrayBuffer());
    const actualMs = await durationViaFfmpeg(mp3);

    // The MP3's real duration must match the manifest's claim within the
    // LAME encoder padding budget (~26ms head + ~36ms tail, per the
    // `wavToMp3` comment in audio-pipeline.ts). The drift bug this test
    // guards against was ~5s of accumulated underreport — well outside
    // this tolerance — so the bound stays tight on purpose.
    expect(Math.abs(actualMs - manifest.duration)).toBeLessThan(150);

    // Per-chapter MP3 files are also written by generate.ts and must
    // match the manifest's per-chapter ranges (within the same per-file
    // encoder-padding budget). Catches a drift that nets out across the
    // whole track but still leaves individual chapter offsets wrong.
    for (const c of manifest.chapters) {
      const chapterMp3 = new Uint8Array(
        await Bun.file(join(outDir, `${c.id}.mp3`)).arrayBuffer(),
      );
      const chapterMs = await durationViaFfmpeg(chapterMp3);
      const claimedMs = c.endTime - c.startTime;
      expect(Math.abs(chapterMs - claimedMs)).toBeLessThan(150);
    }

    // Chapter ranges must be contiguous with the standard 200ms gap, and
    // every mark must lie inside its chapter's [start, end]. The drift bug
    // wouldn't have violated this property (the math was self-consistent;
    // it just disagreed with the audio), but a future "I'll just hand-roll
    // the offsets" regression would, so it's cheap insurance.
    let prevEnd = 0;
    for (const [i, c] of manifest.chapters.entries()) {
      if (i > 0) expect(c.startTime - prevEnd).toBe(200);
      expect(c.endTime).toBeGreaterThan(c.startTime);
      prevEnd = c.endTime;
    }
    for (const m of manifest.marks) {
      const c = manifest.chapters.find((c) => c.id === m.chapter)!;
      expect(m.time).toBeGreaterThanOrEqual(c.startTime);
      expect(m.time).toBeLessThanOrEqual(c.endTime);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("end-to-end: silent segments still have a valid Xing/Info MP3 header", async () => {
  // The other guard the player depends on: the emitted MP3 must carry a
  // Xing/Info VBR header so `HTMLMediaElement.duration` resolves to the
  // real number, not Infinity. `wavToMp3` is unit-tested for this on
  // standalone silence; this re-asserts it survives the full generate
  // pipeline (concat + encode + content-hash filename + manifest wiring).
  const root = await mkdtemp(join(tmpdir(), "presidocs-generate-test-"));
  try {
    await mkdir(join(root, "posts"), { recursive: true });
    const postFile = "posts/test-post.html";
    await Bun.write(join(root, postFile), FIXTURE_HTML);
    const { exitCode, stderr } = await runGenerate(root, postFile);
    if (exitCode !== 0) throw new Error(`generate.ts exited ${exitCode}:\n${stderr}`);

    const manifest = (await Bun.file(join(root, "generated", "test-post", "manifest.json")).json()) as {
      audio: string;
    };
    const mp3 = new Uint8Array(await Bun.file(join(root, manifest.audio)).arrayBuffer());
    const head = new TextDecoder("latin1").decode(mp3.subarray(0, 2048));
    expect(head.includes("Xing") || head.includes("Info")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

// Sanity check: the working-format math the integration test relies on
// (pcmDurationMs reading the WAV header) really is what the production
// pipeline uses. If `createMp3AudioPipeline` ever wires `duration` back to
// `durationViaFfmpeg`, the integration test above will start to fail by
// ~46ms per segment — but this one fails first, on the actual wiring,
// pointing at the line that needs to change.
test("createMp3AudioPipeline's duration op reads the WAV header, not ffmpeg `time=`", async () => {
  const fmt: AudioFormat = { sampleRate: 22050, channels: 1, bitsPerSample: 16 };
  const pipeline = createMp3AudioPipeline(fmt, "64k");
  // Pick a duration whose true value is known to disagree with
  // ffmpeg's `-stats time=` reporting (verified empirically: a 19,633ms
  // PCM buffer reports as `time=00:00:19.59`, a 43ms under-report).
  const buf = await buildSilence(asMs(19_633), fmt);
  expect(await pipeline.duration(buf)).toBe(pcmDurationMs(buf, fmt));
});
