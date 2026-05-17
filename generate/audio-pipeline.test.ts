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
  trimLeadingMs,
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
