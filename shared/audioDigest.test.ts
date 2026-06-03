// Unit tests for the integrity/digest formatters (shared/audioDigest.ts).
// Locked to known SHA-256 vectors: the empty-string digest's Base64 is the very
// value RFC 9530's example uses (`sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:`),
// which is mirrored in specs/DigestFields-spec.html.

import { describe, expect, test } from "bun:test";
import { isSha256Hex, reprDigestSha256, sriSha256 } from "./audioDigest.ts";

// sha256("") and sha256("abc"), full hex.
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const EMPTY_B64 = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
const ABC_B64 = "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=";

describe("reprDigestSha256 (RFC 9530)", () => {
  test("emits sha-256=:<base64>: — matching the RFC's empty-string example", () => {
    expect(reprDigestSha256(EMPTY)).toBe(`sha-256=:${EMPTY_B64}:`);
    expect(reprDigestSha256(ABC)).toBe(`sha-256=:${ABC_B64}:`);
  });
});

describe("sriSha256 (W3C SRI, for podcast:integrity)", () => {
  test("emits sha256-<base64> (same Base64, no colons)", () => {
    expect(sriSha256(EMPTY)).toBe(`sha256-${EMPTY_B64}`);
    expect(sriSha256(ABC)).toBe(`sha256-${ABC_B64}`);
  });
});

describe("isSha256Hex", () => {
  test("accepts a full 64-hex digest, rejects the truncated token and junk", () => {
    expect(isSha256Hex(EMPTY)).toBe(true);
    expect(isSha256Hex("88ec61b30372d408")).toBe(false); // 16-hex filename token
    expect(isSha256Hex(EMPTY.toUpperCase())).toBe(true); // case-insensitive
    expect(isSha256Hex("xyz")).toBe(false);
    expect(isSha256Hex("")).toBe(false);
  });
});
