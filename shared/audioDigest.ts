// Format the audio's full SHA-256 digest as the two standards-defined integrity
// strings we expose for the stable episode URL (see methodology.md →
// Stable shareable episode URL):
//
//   - RFC 9530 `Repr-Digest: sha-256=:<base64>:` — a representation-level digest
//     (range-independent, unlike `Content-Digest`), so it's valid on a 200, a
//     206, or a 304. Emitted by the dev server and the Worker on the stable URL.
//   - W3C SRI `sha256-<base64>` — the value of `<podcast:integrity type="sri">`
//     in the podcast feed, so capable clients can verify the enclosure bytes.
//
// Both want the standard Base64 (RFC 4648) of the RAW 32 digest bytes — NOT the
// hex we store in the manifest, and NOT base64url. The manifest persists the
// full hex (generate.ts); these helpers convert at emit time.
//
// Pure and runtime-agnostic: the hex→base64 conversion uses the native TC39
// `Uint8Array.fromHex()` / `toBase64()` codecs, present in Bun and the pinned
// Workers runtime (verified against the bundled workerd — they are V8 intrinsics
// independent of the `compatibility_date`). `toBase64()` defaults to standard
// Base64 (RFC 4648), exactly the alphabet these strings need (NOT base64url).
// Deliberately NOT imported by the client bundle — only servers/feeds need it,
// so the native methods' "Newly available" browser Baseline is a non-issue here.

/** Full lowercase SHA-256 hex (64 chars). */
export function isSha256Hex(s: string): boolean {
  return /^[0-9a-f]{64}$/i.test(s);
}

function hexToBase64(hex: string): string {
  return Uint8Array.fromHex(hex).toBase64();
}

/** RFC 9530 `Repr-Digest` field value for a full SHA-256 hex digest. */
export function reprDigestSha256(hex: string): string {
  return `sha-256=:${hexToBase64(hex)}:`;
}

/** W3C SRI string for a full SHA-256 hex digest (`<podcast:integrity>` value). */
export function sriSha256(hex: string): string {
  return `sha256-${hexToBase64(hex)}`;
}
