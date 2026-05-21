// AudioPipeline: every operation the generator does with audio data after
// synthesis — silence, duration, leading-silence detection, trim, concat,
// MP3 encode. Extracted from generate.ts so the individual ops are unit-
// testable. Almost every op is a shell-out to ffmpeg; `concat` is the only
// in-memory PCM byte-splice (see comments on `concatWavs`).

import { $ } from "bun";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { asMs, msToSeconds, type Milliseconds } from "../shared/time.ts";

export interface AudioFormat {
  // Signed linear PCM is assumed throughout.
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

export interface AudioPipeline {
  // Format the pipeline expects on every buffer it consumes/produces (until
  // `encode`). TTS providers must emit audio in this format.
  workingFormat: AudioFormat;
  // Working-format extension, used only for any tmp files written to disk.
  workingExt: string;
  // Delivered-format extension and MIME — shown to the browser.
  deliveryExt: string;
  deliveryMime: string;
  // Binaries this pipeline needs on PATH (e.g. ffmpeg for MP3 encode).
  // Unioned with the TTS provider's binaries at preflight.
  requiredBinaries: readonly string[];

  // Generate silence of the given duration in the working format. Used by
  // --mock and (eventually) for explicit pauses between marks.
  silence(durationMs: Milliseconds): Promise<Uint8Array>;
  // Precise duration of a working-format buffer, rounded to the nearest ms.
  duration(buf: Uint8Array): Promise<Milliseconds>;
  // Splice working-format buffers into one with identical playback. MUST
  // be lossless w.r.t. the audio samples — no re-encode. Stays synchronous
  // and in-memory (byte-splice of PCM data sections)
  concat(bufs: Uint8Array[]): Uint8Array;
  // Detect leading silence and return its length in ms. Returns 0 if no
  // significant silence at the start of the buffer.
  leadingSilenceMs(buf: Uint8Array): Promise<Milliseconds>;
  // Drop the given duration of leading audio and return the result.
  trim(buf: Uint8Array, ms: Milliseconds): Promise<Uint8Array>;
  // Final-mile encode for delivery (e.g. WAV → MP3). A future lossless-
  // delivery backend could make this the identity function.
  encode(workingBuf: Uint8Array): Promise<Uint8Array>;
}

// --- WAV helpers (concat-only) -----------------------------------------------
//
// `concat` is the only audio operation that doesn't shell out to ffmpeg.
// Lossless concat of WAVs in our pinned PCM format is just a byte-splice of
// the data chunks under a fresh header — going through ffmpeg's concat
// demuxer would require N temp files (it can't take multiple stdin pipes)
// and adds no quality or correctness benefit. So we keep a small WAV parser
// here for that one purpose; everything else is ffmpeg below.

// WAV header layout: 12-byte RIFF preamble, then chunks (fmt, data, ...).
// We don't assume the data chunk lives at byte 44 — `say` sometimes emits
// extra metadata chunks before it.
function findChunkRanges(buf: Uint8Array) {
  if (
    buf[0] !== 0x52 || buf[1] !== 0x49 || buf[2] !== 0x46 || buf[3] !== 0x46 // "RIFF"
  ) {
    throw new Error("Not a RIFF file");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 12;
  let fmt: { offset: number; size: number } | null = null;
  let data: { offset: number; size: number } | null = null;
  while (pos + 8 <= buf.byteLength) {
    const id =
      String.fromCharCode(buf[pos]!, buf[pos + 1]!, buf[pos + 2]!, buf[pos + 3]!);
    const size = view.getUint32(pos + 4, true);
    if (id === "fmt ") fmt = { offset: pos + 8, size };
    else if (id === "data") {
      data = { offset: pos + 8, size };
      break;
    }
    // Subchunks are word-aligned per RIFF spec.
    pos += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("WAV missing fmt or data chunk");
  return { fmt, data, view };
}

// Build one canonical-headed WAV from any number of input WAVs that share
// the given PCM format. Lossless byte-splice of data chunks.
export function concatWavs(inputs: Uint8Array[], format: AudioFormat): Uint8Array {
  if (inputs.length === 0) {
    throw new Error("concatWavs: refusing to concat zero inputs");
  }
  const { sampleRate, channels, bitsPerSample } = format;
  const datas = inputs.map((b) => {
    const { data } = findChunkRanges(b);
    return b.subarray(data.offset, data.offset + data.size);
  });
  const totalData = datas.reduce((n, d) => n + d.byteLength, 0);
  const bytesPerSample = channels * (bitsPerSample / 8);
  const out = new Uint8Array(44 + totalData);
  const view = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 36 + totalData, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8);
  out.set([0x66, 0x6d, 0x74, 0x20], 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  out.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, totalData, true);
  let offset = 44;
  for (const d of datas) {
    out.set(d, offset);
    offset += d.byteLength;
  }
  return out;
}

// --- ffmpeg-backed ops -------------------------------------------------------

const tmpDir = () => process.env.TMPDIR ?? "/tmp";
const tmpName = (label: string, ext: string) =>
  join(tmpDir(), `presidocs-${label}-${process.pid}-${Math.random().toString(36).slice(2)}${ext}`);

// Generate silence via ffmpeg's `anullsrc` source, written to a temp file.
// We round-trip through disk (rather than piping stdout) because the wav
// muxer cannot fix up the RIFF / data chunk sizes on a non-seekable pipe,
// and `concatWavs` reads those sizes to locate the PCM payload.
export async function buildSilence(
  durationMs: Milliseconds,
  format: AudioFormat,
): Promise<Uint8Array> {
  const { sampleRate, channels } = format;
  const tmpPath = tmpName("silence", ".wav");
  const durationSec = msToSeconds(durationMs);
  try {
    await $`ffmpeg -hide_banner -loglevel error -f lavfi -i anullsrc=r=${sampleRate}:cl=mono -t ${durationSec} -ac ${channels} -ar ${sampleRate} -c:a pcm_s16le -y ${tmpPath}`.quiet();
    return new Uint8Array(await Bun.file(tmpPath).arrayBuffer());
  } finally {
    await rm(tmpPath, { force: true });
  }
}

// Duration via ffmpeg's `-stats` line. We deliberately don't use ffprobe
// here: its wav demuxer refuses to report `format=duration` for input
// arriving on a non-seekable pipe (it won't trust the data-chunk size
// without a seek to verify), even when the header is correct. Decoding
// to `-f null` and parsing the final `time=HH:MM:SS.ms` line gives us
// the encoder's view of processed input duration, ms-precise, in-memory.
export async function durationViaFfmpeg(buf: Uint8Array): Promise<Milliseconds> {
  const proc = Bun.spawn({
    cmd: [
      "ffmpeg",
      "-hide_banner",
      "-loglevel", "error",
      "-stats",
      "-i", "pipe:0",
      "-f", "null",
      "-",
    ],
    stdin: new Blob([buf as BlobPart]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, errText, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`ffmpeg (duration) exited ${code}:\n${errText}`);
  // Long inputs may emit multiple periodic stats lines; the last one is the
  // total. Short inputs (our typical case) emit exactly one.
  const matches = [...errText.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const last = matches[matches.length - 1];
  if (!last) {
    throw new Error(`ffmpeg (duration) produced no time= stat:\n${errText}`);
  }
  const seconds =
    parseInt(last[1]!, 10) * 3600 + parseInt(last[2]!, 10) * 60 + parseFloat(last[3]!);
  return asMs(Math.round(seconds * 1000));
}

// `say` (and most TTS engines) open each segment with dead silence followed
// by a 50–150ms ramp up into the first phoneme. Without trimming, seeking
// to a chapter boundary lands in that silence and the listener hears nothing
// for a beat before the first word.
//
// `silencedetect` emits to stderr lines like:
//   [silencedetect @ ...] silence_start: 0
//   [silencedetect @ ...] silence_end: 0.142 | silence_duration: 0.142
// We treat anything that doesn't *start* at (≈) t=0 as not leading silence.
//
// `noise=-25dB` approximates the prior RMS≈2000 cutoff on int16 PCM
// (20*log10(2000/32767) ≈ -24dB) — calibrated to catch the first audible
// syllable without clipping soft fricatives like the "S" of "So". `d=0.02`
// matches the prior 20ms-window granularity.
export async function leadingSilenceMs(buf: Uint8Array): Promise<Milliseconds> {
  const proc = Bun.spawn({
    cmd: [
      "ffmpeg",
      "-hide_banner",
      "-nostats",
      "-i", "pipe:0",
      "-af", "silencedetect=noise=-25dB:d=0.02",
      "-f", "null",
      "-",
    ],
    stdin: new Blob([buf as BlobPart]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, errText, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`ffmpeg (silencedetect) exited ${code}:\n${errText}`);
  const startMatch = errText.match(/silence_start:\s*([\d.eE+-]+)/);
  if (!startMatch || parseFloat(startMatch[1]!) > 0.05) return asMs(0);
  const endMatch = errText.match(/silence_end:\s*([\d.eE+-]+)/);
  if (!endMatch) return asMs(0);
  return asMs(Math.max(0, Math.round(parseFloat(endMatch[1]!) * 1000)));
}

// Drop leading audio via ffmpeg `-ss` with stream copy. We round-trip
// through temp files (rather than piping) because the wav muxer cannot fix
// up RIFF / data chunk sizes on a non-seekable pipe, and `concatWavs` reads
// those sizes. `-c copy` keeps it lossless — no PCM re-encode.
export async function trimLeadingMs(
  buf: Uint8Array,
  ms: Milliseconds,
): Promise<Uint8Array> {
  if (ms <= 0) return buf;
  const inPath = tmpName("trim-in", ".wav");
  const outPath = tmpName("trim-out", ".wav");
  const seconds = msToSeconds(ms);
  try {
    await Bun.write(inPath, buf);
    await $`ffmpeg -hide_banner -loglevel error -ss ${seconds} -i ${inPath} -c copy -y ${outPath}`.quiet();
    return new Uint8Array(await Bun.file(outPath).arrayBuffer());
  } finally {
    await Promise.all([rm(inPath, { force: true }), rm(outPath, { force: true })]);
  }
}

// Exact duration of a working-format PCM buffer, read straight from the WAV
// data-chunk size (no subprocess). Lets the trailing-artifact detector below
// know where EOF is without an extra ffmpeg pass.
export function pcmDurationMs(buf: Uint8Array, format: AudioFormat): Milliseconds {
  const { data } = findChunkRanges(buf);
  const bytesPerSec = format.sampleRate * format.channels * (format.bitsPerSample / 8);
  return asMs(Math.round((data.size / bytesPerSec) * 1000));
}

// Autoregressive TTS engines (MOSS among them) often append a brief burst of
// garbage audio AFTER the last word — preceded by a short silence gap, so it
// reads as "speech … <pause> … 50ms of noise <EOF>". It's audible as a click
// or croak at every segment seam once segments are concatenated.
//
// We detect it structurally rather than by trying to classify "noise vs
// speech": run silencedetect, take the LAST point where audio resumes after a
// silence (the last `silence_end`), and if only a short tail remains to EOF,
// treat that tail as the artifact. Returning the cut point at `silence_end`
// drops the blip while KEEPING the silence gap before it as a natural
// inter-sentence pause. Returns null when there's nothing to trim: a buffer
// that ends in speech (no trailing `silence_end`) or in silence (long final
// run) is left untouched, so this is a safe no-op for engines like `say`.
//
// `-35dB` cleanly separates the typical low-energy blip (≈ -34dB observed)
// from true silence (≈ -47dB); `d=0.05` requires a real ≥50ms gap so we never
// cut into rapid speech.
const ARTIFACT_TAIL_MAX_MS = 200;
export async function trailingArtifactTrimMs(
  buf: Uint8Array,
  format: AudioFormat,
): Promise<Milliseconds | null> {
  const totalMs = pcmDurationMs(buf, format);
  const proc = Bun.spawn({
    cmd: [
      "ffmpeg",
      "-hide_banner",
      "-nostats",
      "-i", "pipe:0",
      "-af", "silencedetect=noise=-35dB:d=0.05",
      "-f", "null",
      "-",
    ],
    stdin: new Blob([buf as BlobPart]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, errText, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`ffmpeg (silencedetect/tail) exited ${code}:\n${errText}`);
  // Last `silence_end` = the moment audio last resumed after a gap. If audio
  // never resumes after a silence (file ends mid-silence, or pure speech with
  // no gaps), there's no artifact tail to cut.
  const ends = [...errText.matchAll(/silence_end:\s*([\d.eE+-]+)/g)];
  const lastEnd = ends[ends.length - 1];
  if (!lastEnd) return null;
  const lastEndMs = Math.round(parseFloat(lastEnd[1]!) * 1000);
  const finalRunMs = totalMs - lastEndMs;
  if (finalRunMs > 0 && finalRunMs <= ARTIFACT_TAIL_MAX_MS) return asMs(lastEndMs);
  return null;
}

// Truncate a working-format buffer to keep only its first `ms`. Like
// `trimLeadingMs`, round-trips through temp files (not a pipe) so the WAV
// muxer can fix up RIFF/data-chunk sizes that `concatWavs` later reads. We
// re-encode `pcm_s16le` rather than `-c copy`: copy truncates at coarse packet
// boundaries (tens of ms off), while a PCM→PCM re-encode is sample-accurate
// AND still lossless (the samples pass through unchanged).
export async function truncateToMs(buf: Uint8Array, ms: Milliseconds): Promise<Uint8Array> {
  const inPath = tmpName("trunc-in", ".wav");
  const outPath = tmpName("trunc-out", ".wav");
  const seconds = msToSeconds(ms);
  try {
    await Bun.write(inPath, buf);
    await $`ffmpeg -hide_banner -loglevel error -i ${inPath} -t ${seconds} -c:a pcm_s16le -y ${outPath}`.quiet();
    return new Uint8Array(await Bun.file(outPath).arrayBuffer());
  } finally {
    await Promise.all([rm(inPath, { force: true }), rm(outPath, { force: true })]);
  }
}

// MP3 encoder via ffmpeg. Stream-in / stream-out so we never touch disk for
// the intermediate WAV — important because the working buffers can be tens
// of megabytes for long posts.
//
// MP3 encoding adds a small lookahead/padding (~26ms at the head, ~36ms at
// the tail) per the format spec. Modern decoders honor the LAME tag we
// emit and play gaplessly; the residual sub-30ms offset is well below
// perception thresholds at podcast-scale durations.
export async function wavToMp3(
  wavBuf: Uint8Array,
  format: AudioFormat,
  mp3Bitrate: string,
): Promise<Uint8Array> {
  const proc = Bun.spawn({
    cmd: [
      "ffmpeg",
      "-hide_banner",
      "-loglevel", "error",
      "-f", "wav",
      "-i", "pipe:0",
      "-codec:a", "libmp3lame",
      "-b:a", mp3Bitrate,
      "-ac", String(format.channels),
      "-ar", String(format.sampleRate),
      "-f", "mp3",
      "pipe:1",
    ],
    stdin: new Blob([wavBuf as BlobPart]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [outBytes, errText, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`ffmpeg (mp3) exited ${code}:\n${errText}`);
  return new Uint8Array(outBytes);
}

// --- Factory -----------------------------------------------------------------

export function createMp3AudioPipeline(
  format: AudioFormat,
  mp3Bitrate: string,
): AudioPipeline {
  return {
    workingFormat: format,
    workingExt: ".wav",
    deliveryExt: ".mp3",
    deliveryMime: "audio/mpeg",
    requiredBinaries: ["ffmpeg"],
    silence: (ms) => buildSilence(ms, format),
    duration: durationViaFfmpeg,
    concat: (bufs) => concatWavs(bufs, format),
    leadingSilenceMs,
    trim: trimLeadingMs,
    encode: (buf) => wavToMp3(buf, format, mp3Bitrate),
  };
}
