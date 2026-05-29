import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAuthorVoice } from "./voiceResolution.ts";

// The resolver has only one resolution path: voices/<author-email>.wav. There
// is intentionally no env-var fallback (a single global default re-introduces
// the wrong-voice bug on a multi-author blog).
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "voice-res-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeClip(path: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, new Uint8Array(4)); // empty-ish WAV stand-in; resolver only existsSync's it
}

test("resolves voices/<author-email>.wav when it exists", () => {
  const expected = join(root, "voices", "alice@example.com.wav");
  writeClip(expected);
  const r = resolveAuthorVoice(root, "alice@example.com");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.clipPath).toBe(expected);
});

test("matches case-insensitively (email is lowercased)", () => {
  writeClip(join(root, "voices", "alice@example.com.wav"));
  const r = resolveAuthorVoice(root, "Alice@Example.COM");
  expect(r.ok).toBe(true);
});

test("fails clearly when the per-author file is missing", () => {
  const r = resolveAuthorVoice(root, "ghost@example.com");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toMatch(/voices\/ghost@example\.com\.wav/);
});

test("fails when the post has no author-email", () => {
  const r = resolveAuthorVoice(root, null);
  expect(r.ok).toBe(false);
});

test("refuses an email that would escape the voices/ dir", () => {
  // Even if `voices/../etc/passwd.wav` existed on disk, the resolver must not
  // treat a `/` in the email component as a valid filename — that would let
  // an authored email steer the spawn at an arbitrary file.
  const r = resolveAuthorVoice(root, "../etc/passwd");
  expect(r.ok).toBe(false);
});
