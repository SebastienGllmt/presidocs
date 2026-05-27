// Regression tests for the AudioPipeline ffmpeg replacements. Each op is
// covered individually plus one end-to-end test (silence + sound → detect
// silence → trim it → verify what's left). Fixtures are generated via
// ffmpeg's `sine=` and `anullsrc=` lavfi sources so tests don't depend
// on a TTS engine.

import { test, expect } from "bun:test";
import { $ } from "bun";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  buildSilence,
  concatWavs,
  createMp3AudioPipeline,
  durationViaFfmpeg,
  leadingSilenceMs,
  leadingSilenceTrimMs,
  pcmDurationMs,
  trailingArtifactTrimMs,
  trimLeadingMs,
  truncateToMs,
  wavToMp3,
  type AudioFormat,
} from "./audio-pipeline.ts";
import { asMs, msToSeconds, type Milliseconds } from "../shared/time.ts";

const fmt: AudioFormat = { sampleRate: 22050, channels: 1, bitsPerSample: 16 };

// 440Hz sine wave at full amplitude — well above silencedetect's -25dB
// threshold, so it stands in for "real audio" in leading-silence tests.
async function makeSineWav(durationMs: Milliseconds, freq = 440): Promise<Uint8Array> {
  const durationSec = msToSeconds(durationMs);
  const tmp = join(
    process.env.TMPDIR ?? "/tmp",
    `audio-pipeline-test-sine-${process.pid}-${Math.random().toString(36).slice(2)}.wav`,
  );
  try {
    await $`ffmpeg -hide_banner -loglevel error -f lavfi -i sine=frequency=${freq}:duration=${durationSec}:sample_rate=${fmt.sampleRate} -ac ${fmt.channels} -c:a pcm_s16le -y ${tmp}`.quiet();
    return new Uint8Array(await Bun.file(tmp).arrayBuffer());
  } finally {
    await rm(tmp, { force: true });
  }
}

test("buildSilence produces a WAV of the requested duration", async () => {
  const buf = await buildSilence(asMs(1500), fmt);
  expect(buf[0]).toBe(0x52); // "R" of RIFF
  expect(buf[1]).toBe(0x49); // "I"
  const dur = await durationViaFfmpeg(buf);
  expect(dur).toBeCloseTo(1500, -2);
});

test("durationViaFfmpeg handles a piped WAV (ffprobe regression)", async () => {
  // ffprobe's wav demuxer returns N/A for format=duration on a piped WAV,
  // even when the header is correct, because it won't seek to verify the
  // data-chunk size. durationViaFfmpeg uses `ffmpeg -f null -stats` to
  // sidestep that. If this test starts failing with "no time= stat" or
  // similar, ffmpeg's stats line format has changed.
  const buf = await buildSilence(asMs(700), fmt);
  const dur = await durationViaFfmpeg(buf);
  expect(dur).toBeCloseTo(700, -2);
});

test("leadingSilenceMs returns 0 when audio starts with sound", async () => {
  const sound = await makeSineWav(asMs(500));
  expect(await leadingSilenceMs(sound)).toBe(asMs(0));
});

test("leadingSilenceMs detects a leading silent gap", async () => {
  const silence = await buildSilence(asMs(300), fmt);
  const sound = await makeSineWav(asMs(500));
  const combined = concatWavs([silence, sound], fmt);
  const leading = await leadingSilenceMs(combined);
  // silencedetect's d=0.02 window means the reported boundary lands within
  // a frame or two of the true split — 50ms tolerance is comfortable.
  expect(leading).toBeGreaterThan(250);
  expect(leading).toBeLessThan(350);
});

test("leadingSilenceMs ignores silence that doesn't start at t≈0", async () => {
  // sound, then a silent gap mid-stream, then more sound — must NOT be
  // reported as leading silence.
  const sound = await makeSineWav(asMs(300));
  const gap = await buildSilence(asMs(300), fmt);
  const combined = concatWavs([sound, gap, sound], fmt);
  expect(await leadingSilenceMs(combined)).toBe(asMs(0));
});

test("leadingSilenceTrimMs keeps a short lead untrimmed (guard protects soft onsets)", async () => {
  const silence = await buildSilence(asMs(300), fmt);
  const sound = await makeSineWav(asMs(500));
  const combined = concatWavs([silence, sound], fmt);
  // The default 1s guard is far longer than the 300ms lead, so nothing is
  // trimmed — this is what stops a quiet word-initial fricative (mis-detected
  // as silence) from being clipped.
  expect(await leadingSilenceTrimMs(combined)).toBe(asMs(0));
});

test("leadingSilenceTrimMs trims only the excess beyond the guard", async () => {
  const silence = await buildSilence(asMs(300), fmt);
  const sound = await makeSineWav(asMs(500));
  const combined = concatWavs([silence, sound], fmt);
  // With a small 100ms guard, a ~300ms lead trims ~200ms, leaving ~100ms of
  // silence before the detected onset.
  const trim = await leadingSilenceTrimMs(combined, asMs(100));
  expect(trim).toBeGreaterThan(150);
  expect(trim).toBeLessThan(250);
});

test("trimLeadingMs(buf, 0) is the identity (same reference)", async () => {
  const buf = await buildSilence(asMs(1000), fmt);
  expect(await trimLeadingMs(buf, asMs(0))).toBe(buf);
});

test("trimLeadingMs removes the requested duration", async () => {
  const buf = await buildSilence(asMs(1500), fmt);
  const trimmed = await trimLeadingMs(buf, asMs(500));
  expect(await durationViaFfmpeg(trimmed)).toBeCloseTo(1000, -2);
});

test("concatWavs sums input durations losslessly", async () => {
  const a = await buildSilence(asMs(500), fmt);
  const b = await buildSilence(asMs(800), fmt);
  const combined = concatWavs([a, b], fmt);
  expect(await durationViaFfmpeg(combined)).toBeCloseTo(1300, -2);
});

test("concatWavs refuses zero inputs", () => {
  expect(() => concatWavs([], fmt)).toThrow();
});

test("wavToMp3 produces a playable MP3 of similar duration", async () => {
  const wav = await buildSilence(asMs(1000), fmt);
  const mp3 = await wavToMp3(wav, fmt, "64k");
  // MP3 starts with either an ID3 tag ("ID3") or a sync word (0xFFFB / 0xFFFA).
  const isId3 = mp3[0] === 0x49 && mp3[1] === 0x44 && mp3[2] === 0x33;
  const isSync = mp3[0] === 0xff && (mp3[1]! & 0xe0) === 0xe0;
  expect(isId3 || isSync).toBe(true);
  // The encode must carry a Xing/Info VBR header (the frame holding the total
  // frame count, i.e. the exact duration). Without it browsers report
  // `duration === Infinity` and Shikwasa shows "LIVE" instead of the time
  // remaining. ffmpeg only writes this header to a seekable output, so this
  // guards against regressing back to piping the encode to stdout.
  const ascii = new TextDecoder("latin1").decode(mp3.subarray(0, 2048));
  expect(ascii.includes("Xing") || ascii.includes("Info")).toBe(true);
  const dur = await durationViaFfmpeg(mp3);
  // LAME adds ~26ms head + ~36ms tail of encoder padding per file. Stay
  // loose so this doesn't fail on encoder version bumps.
  expect(Math.abs(dur - 1000)).toBeLessThan(200);
});

test("end-to-end: silence + sound → detect → trim → verify what's left", async () => {
  const silence = await buildSilence(asMs(300), fmt);
  const sound = await makeSineWav(asMs(500));
  const combined = concatWavs([silence, sound], fmt);

  const leading = await leadingSilenceMs(combined);
  const trimmed = await trimLeadingMs(combined, leading);
  const afterDur = await durationViaFfmpeg(trimmed);

  // What's left after trimming should be (≈) the sound portion alone.
  expect(afterDur).toBeCloseTo(500, -2);
});

test("pcmDurationMs reads duration from the WAV header (no subprocess)", async () => {
  const buf = await buildSilence(asMs(1234), fmt);
  expect(pcmDurationMs(buf, fmt)).toBeCloseTo(1234, -2);
});

test("truncateToMs keeps only the first N ms", async () => {
  const buf = await makeSineWav(asMs(1000));
  const cut = await truncateToMs(buf, asMs(600));
  expect(await durationViaFfmpeg(cut)).toBeCloseTo(600, -2);
});

test("trailingArtifactTrimMs detects a short noise burst after a trailing silence gap", async () => {
  // speech … <120ms gap> … 80ms blip <EOF> — the MOSS tail-artifact shape.
  const speech = await makeSineWav(asMs(1000));
  const gap = await buildSilence(asMs(120), fmt);
  const blip = await makeSineWav(asMs(80), 1200);
  const combined = concatWavs([speech, gap, blip], fmt);

  const keep = await trailingArtifactTrimMs(combined, fmt);
  expect(keep).not.toBeNull();
  // Cut point sits at the end of the gap (~1120ms): blip dropped, gap kept as
  // the natural inter-sentence pause. silencedetect lands within a frame.
  expect(keep!).toBeGreaterThan(1080);
  expect(keep!).toBeLessThan(1160);
});

test("trailingArtifactTrimMs returns null when audio ends in speech (no artifact)", async () => {
  const speech = await makeSineWav(asMs(800));
  expect(await trailingArtifactTrimMs(speech, fmt)).toBeNull();
});

test("trailingArtifactTrimMs returns null when audio ends in silence", async () => {
  const speech = await makeSineWav(asMs(600));
  const trailing = await buildSilence(asMs(300), fmt);
  const combined = concatWavs([speech, trailing], fmt);
  expect(await trailingArtifactTrimMs(combined, fmt)).toBeNull();
});

test("trailingArtifactTrimMs leaves a long mid-clip pause alone (not an artifact)", async () => {
  // speech … <100ms pause> … 500ms more speech — the final run is long, so
  // this is a real pause, not a trailing blip.
  const a = await makeSineWav(asMs(500));
  const gap = await buildSilence(asMs(100), fmt);
  const b = await makeSineWav(asMs(500));
  const combined = concatWavs([a, gap, b], fmt);
  expect(await trailingArtifactTrimMs(combined, fmt)).toBeNull();
});

test("createMp3AudioPipeline wires the factory to the same ops", async () => {
  const p = createMp3AudioPipeline(fmt, "64k");
  expect(p.requiredBinaries).toEqual(["ffmpeg"]);
  expect(p.deliveryExt).toBe(".mp3");
  expect(p.deliveryMime).toBe("audio/mpeg");
  // Round-trip through the factory's methods to confirm wiring.
  const buf = await p.silence(asMs(400));
  expect(await p.duration(buf)).toBeCloseTo(400, -2);
  const mp3 = await p.encode(buf);
  expect(mp3.byteLength).toBeGreaterThan(0);
});
