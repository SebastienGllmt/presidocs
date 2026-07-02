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

import { test, expect, spyOn } from "bun:test";
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
import {
  buildManifestParts,
  hashedManifestName,
  mergeLexicons,
  resolveForcedTexts,
} from "./generate.ts";
import { asMs } from "../shared/time.ts";
import { findManifestName } from "../shared/manifestFile.ts";

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
    const manifestName = (await findManifestName(outDir))!;
    const manifest = (await Bun.file(join(outDir, manifestName)).json()) as {
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

    const outDir = join(root, "generated", "test-post");
    const manifestName = (await findManifestName(outDir))!;
    const manifest = (await Bun.file(join(outDir, manifestName)).json()) as {
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

// --- Pure-stage unit tests (4.3) --------------------------------------------
// The end-to-end tests above (and the golden generate runs) enforce the byte
// contract; these lock the arithmetic and the manifest byte-contract (absent-
// key invariant, name-hash field subset) that the goldens can't isolate — and
// the word projection, which isn't golden-runnable without QWEN3_ALIGNER_DIR.

// Minimal ChapterArtifact factory — buildManifestParts reads only id/title/
// duration/localMarks/trimMs; `buffer` is required by the type but unused here.
type LocalMark = {
  name: string;
  time: ReturnType<typeof asMs>;
  text: string;
  segmentStartInChapter: ReturnType<typeof asMs>;
  words?: { s: number; e: number; t: ReturnType<typeof asMs>; d: ReturnType<typeof asMs> }[];
  figure?: string;
  step?: string;
};
function artifact(
  id: string,
  title: string,
  durationMs: number,
  localMarks: LocalMark[],
  trimMsN = 0,
) {
  return {
    id,
    title,
    buffer: new Uint8Array(),
    duration: asMs(durationMs),
    localMarks,
    trimMs: asMs(trimMsN),
  };
}

// --- buildManifestParts: gap arithmetic + parentId ---------------------------

test("buildManifestParts advances chapter offsets by segmentGapMs and carries parentId", () => {
  const chapters = [
    { id: "A", title: "Alpha", content: "" },
    { id: "B", title: "Beta", content: "", parentId: "A" },
  ];
  const artifacts = [
    artifact("A", "Alpha", 1000, [{ name: "a0", time: asMs(0), text: "A0", segmentStartInChapter: asMs(0) }]),
    artifact("B", "Beta", 500, [{ name: "b0", time: asMs(50), text: "B0", segmentStartInChapter: asMs(50) }]),
  ];
  const { manifestChapters, manifestMarks, duration } = buildManifestParts(artifacts, chapters, asMs(200));

  // Chapter A: 0..1000. Chapter B: +200 gap → 1200..1700.
  expect(manifestChapters[0]).toMatchObject({ id: "A", startTime: 0, endTime: 1000 });
  expect(manifestChapters[1]).toMatchObject({ id: "B", startTime: 1200, endTime: 1700, parentId: "A" });
  // Flat chapter serializes with parentId ABSENT (undefined value dropped).
  expect(manifestChapters[0]!.parentId).toBeUndefined();
  expect(JSON.stringify(manifestChapters[0])).not.toContain("parentId");
  expect(JSON.stringify(manifestChapters[1])).toContain('"parentId":"A"');

  // Mark times are chapter-start + local time.
  expect(manifestMarks[0]).toMatchObject({ name: "a0", time: 0, chapter: "A" });
  expect(manifestMarks[1]).toMatchObject({ name: "b0", time: 1250, chapter: "B" });

  expect(duration).toBe(asMs(1700));
});

// --- buildManifestParts: word projection math --------------------------------

test("buildManifestParts projects words with trim clamp and drops entirely-trimmed words", () => {
  const artifacts = [
    artifact("A", "Alpha", 1000, [
      {
        name: "m",
        time: asMs(0),
        text: "words",
        segmentStartInChapter: asMs(50),
        words: [
          // rawEnd = 50 + 0 - 100 + 30 = -20 <= 0 → dropped entirely.
          { s: 0, e: 1, t: asMs(0), d: asMs(30) },
          // rawStart = 50 + 60 - 100 = 10; clamped 10; d = 100.
          { s: 1, e: 2, t: asMs(60), d: asMs(100) },
          // rawStart = 50 + 40 - 100 = -10 → clamp to 0; dur = max(0, 90-0)=90.
          { s: 2, e: 3, t: asMs(40), d: asMs(100) },
        ],
      },
    ], 100),
  ];
  const { manifestMarks } = buildManifestParts(artifacts, [{ id: "A", title: "Alpha", content: "" }], asMs(0));

  expect(manifestMarks[0]!.words).toEqual([
    { s: 1, e: 2, t: asMs(10), d: asMs(100) },
    { s: 2, e: 3, t: asMs(0), d: asMs(90) },
  ]);
});

test("buildManifestParts drops the words key when every word is trimmed away", () => {
  const artifacts = [
    artifact("A", "Alpha", 1000, [
      {
        name: "m",
        time: asMs(0),
        text: "gone",
        segmentStartInChapter: asMs(0),
        // rawEnd = 0 + 0 - 100 + 50 = -50 <= 0 → dropped → empty → undefined.
        words: [{ s: 0, e: 1, t: asMs(0), d: asMs(50) }],
      },
    ], 100),
  ];
  const { manifestMarks } = buildManifestParts(artifacts, [{ id: "A", title: "Alpha", content: "" }], asMs(0));

  expect(manifestMarks[0]!.words).toBeUndefined();
  expect(JSON.stringify(manifestMarks[0])).not.toContain("words");
});

// --- buildManifestParts: absent-key invariant (the manifest byte-contract) ---

test("buildManifestParts omits figure/step/words keys for a bare mark", () => {
  const artifacts = [
    artifact("A", "Alpha", 1000, [
      { name: "bare", time: asMs(0), text: "hi", segmentStartInChapter: asMs(0) },
    ]),
  ];
  const { manifestMarks } = buildManifestParts(artifacts, [{ id: "A", title: "Alpha", content: "" }], asMs(0));
  const json = JSON.stringify(manifestMarks[0]);
  expect(json).not.toContain("figure");
  expect(json).not.toContain("step");
  expect(json).not.toContain("words");
});

test("buildManifestParts carries figure/step literals verbatim, including empty and 'none'", () => {
  const artifacts = [
    artifact("A", "Alpha", 1000, [
      { name: "clear", time: asMs(0), text: "a", segmentStartInChapter: asMs(0), figure: "", step: "none" },
      { name: "set", time: asMs(0), text: "b", segmentStartInChapter: asMs(0), figure: "fig-1", step: "s2" },
    ]),
  ];
  const { manifestMarks } = buildManifestParts(artifacts, [{ id: "A", title: "Alpha", content: "" }], asMs(0));
  expect(manifestMarks[0]).toMatchObject({ figure: "", step: "none" });
  expect(manifestMarks[1]).toMatchObject({ figure: "fig-1", step: "s2" });
  // An explicit empty-string figure is a real key with "" — not absent.
  expect(JSON.stringify(manifestMarks[0])).toContain('"figure":""');
});

// --- hashedManifestName: the name-hash field subset --------------------------

test("hashedManifestName ignores generatedAt/slug/audioBytes/provenance", () => {
  const base = {
    slug: "post-a",
    generatedAt: "2020-01-01T00:00:00.000Z",
    audio: "/generated/post/full.abc.mp3",
    audioDigest: "deadbeef",
    audioBytes: 111,
    provenance: { tts: "espeak-ng", voice: "en-us", aligner: null, alignLanguage: null, mock: false },
    duration: asMs(1000),
    chapters: [],
    marks: [],
  };
  const varied = {
    ...base,
    slug: "post-b",
    generatedAt: "2099-12-31T23:59:59.999Z",
    audioBytes: 999999,
    provenance: { tts: "moss", voice: "clip.wav", aligner: "qwen3", alignLanguage: "English", mock: true },
  };
  expect(hashedManifestName(varied)).toBe(hashedManifestName(base));
});

test("hashedManifestName changes when the marks change", () => {
  const base = {
    audio: "/a",
    audioDigest: "dd",
    duration: asMs(1000),
    chapters: [],
    marks: [],
  };
  const withMark = {
    ...base,
    marks: [{ name: "m", time: asMs(0), chapter: "A", text: "hi" }],
  };
  expect(hashedManifestName(withMark)).not.toBe(hashedManifestName(base));
});

// --- mergeLexicons: root wrapper + <!-- from label --> stitching -------------

test("mergeLexicons stitches source bodies under one root, in order", () => {
  const merged = mergeLexicons([
    { label: "posts/common-terms.pls", xml: "<lexicon><lexeme>first</lexeme></lexicon>" },
    { label: "inline:posts/x.html#0", xml: "<lexicon><lexeme>second</lexeme></lexicon>" },
  ]);
  expect(merged.sources).toEqual(["posts/common-terms.pls", "inline:posts/x.html#0"]);
  expect(merged.xml).toStartWith(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<lexicon version="1.0" xmlns="http://www.w3.org/2005/01/pronunciation-lexicon" xml:lang="en-US">\n`,
  );
  expect(merged.xml).toContain(`<!-- from posts/common-terms.pls --><lexeme>first</lexeme>`);
  expect(merged.xml).toContain(`<!-- from inline:posts/x.html#0 --><lexeme>second</lexeme>`);
  // Order: common-terms body before the inline body.
  expect(merged.xml.indexOf("first")).toBeLessThan(merged.xml.indexOf("second"));
  expect(merged.xml).toEndWith(`\n</lexicon>\n`);
});

// --- resolveForcedTexts: mark→text + missing-mark warn -----------------------

test("resolveForcedTexts resolves forced mark names to their segment text", () => {
  const chapters = [
    { id: "c", title: "C", content: `<mark name="m1"/> Hello world. <mark name="m2"/> Second bit.` },
  ];
  const forced = resolveForcedTexts(chapters, new Set(["m1"]));
  expect([...forced]).toEqual(["Hello world."]);
});

test("resolveForcedTexts warns about mark names that match no segment", () => {
  const chapters = [
    { id: "c", title: "C", content: `<mark name="m1"/> Hello world.` },
  ];
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const forced = resolveForcedTexts(chapters, new Set(["m1", "nope"]));
    expect([...forced]).toEqual(["Hello world."]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("nope");
  } finally {
    warn.mockRestore();
  }
});
