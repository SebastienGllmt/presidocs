// Property-based tests for the unified serving engine (server/serveAsset.ts),
// complementing the example-based tests in `serveAsset.test.ts`. Those pin
// down specific hand-written HTTP scenarios (row-11 If-Range guard, the D1 416
// problem+json contract); these assert the *classes* of invariant the split
// exposed — the status space over ANY Range string, 206 byte arithmetic,
// range-partition reconstruction, the 416 `no-store` override, the If-Range
// posture knob, and header preservation — over randomly generated (incl.
// adversarial/malformed) inputs. This is the Phase-5b "test the risk the
// splits exposed" workstream: `serveAsset` is pure ((source, options) →
// Response, no IO), which is exactly what makes it property-testable.
//
// Contract source of truth: proposals/refactor/phase3/3a-serving-unification.md
// §3 "serveAsset semantics (normative)". We do NOT re-derive semantics here.
//
// fast-check conventions (numRuns, structure, seed handling) mirror
// client/commentsStore.properties.test.ts. On failure fast-check's default
// reporter prints the seed + counterexample + shrink path, so a red run is
// reproducible without any extra wiring.
//
// No happydom.ts import (per 5b rules): these assertions run on Bun's native
// Request/Response/Headers. Verified identical solo and in the full `bun test`
// run — no useNativeWebClasses() needed here (serveAsset touches no cookies /
// Set-Cookie, the only headers happy-dom mangles).

import { test, expect } from "bun:test";
import * as fc from "fast-check";
import {
  serveAsset,
  conditionalNotModified,
  stableEpisodeResponseHeaders,
  type AssetSource,
} from "./serveAsset.ts";
// resolveRange is used ONLY as a dispatch oracle: it is separately unit-tested
// (shared/httpRange.test.ts), so predicting serveAsset's status from it tests
// that serveAsset *wires the verdict through* correctly. The byte/header
// arithmetic below (Content-Range string, Content-Length, sliced body,
// no-store override, header merge) is serveAsset's own logic and is asserted
// directly, never via a helper.
import { resolveRange } from "../shared/httpRange.ts";
import { reprDigestSha256 } from "../shared/audioDigest.ts";

// ---- Sources --------------------------------------------------------------
// Bounded to a few KB so the whole file stays well under ~2 s. Real byte
// content (not a constant) so slice-identity checks are meaningful. The
// `new Uint8Array(a)` copy re-backs fast-check's `ArrayBufferLike` array with a
// concrete `ArrayBuffer` so it satisfies `BodyInit` (AssetSource.slice/whole).
const bytesArb = fc.uint8Array({ minLength: 1, maxLength: 4096 }).map((a) => new Uint8Array(a));

function sourceOf(bytes: Uint8Array<ArrayBuffer>): AssetSource {
  return {
    size: bytes.length,
    slice: (s, e) => bytes.subarray(s, e + 1), // [s, e] INCLUSIVE (per AssetSource)
    whole: () => bytes,
  };
}

async function bodyBytes(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

const CONTENT_RANGE_RE = /^bytes (\d+)-(\d+)\/(\d+)$/;

// ---- Range-string arbitraries ---------------------------------------------
// Every generated string uses only header-safe bytes (digits, letters, and
// `-,= ` space) so `new Headers({ Range })` never throws — the "never throws"
// claim under test is about serveAsset, not about header construction.
const rangeChar = fc.constantFrom(..."0123456789-, =abcxyzBYTES".split(""));
const rangeFuzz = fc.string({ unit: rangeChar, maxLength: 14 });

// A grab-bag of the documented adversarial shapes (§ task list) plus generated
// fuzz. Includes inverted (`bytes=99-0` → 416), invalid (`bytes=-` → 200),
// multi-range (→ 200), non-bytes units, huge numbers, empty, whitespace.
const adversarialRange = fc.oneof(
  fc.constantFrom(
    "bytes=99-0", // inverted → unsatisfiable → 416
    "bytes=-", // RFC-invalid empty-empty → 200
    "bytes=a-b", // non-numeric → 200
    "bytes=0-1,5-9", // multi-range (unsupported) → 200
    "bytes=0-9,10-19", // multi-range → 200
    "items=0-5", // non-bytes unit → 200
    "bytes=0-99999999999999999999", // huge end (clamped) → 206
    "bytes=99999999999999999999-", // huge start → 416
    "", // empty → 200
    " ", // whitespace → 200
    "bytes=", // no spec → 200
    "bytes= 0-9", // internal space → 200
    " bytes=0-9 ", // surrounding ws (trimmed) → 206
    "bytes=-0", // suffix length 0 → 416
    "bytes=0-0", // single byte → 206
  ),
  rangeFuzz,
  rangeFuzz.map((t) => `bytes=${t}`),
  fc
    .tuple(fc.integer({ min: 0, max: 100000 }), fc.integer({ min: 0, max: 100000 }))
    .map(([a, b]) => `bytes=${a}-${b}`),
);

// Optional Range: `null` means "no Range header at all".
const maybeRange = fc.option(adversarialRange, { nil: null });

function reqHeaders(range: string | null, ifRange?: string | null): Headers {
  const h = new Headers();
  if (range !== null) h.set("Range", range);
  if (ifRange != null) h.set("If-Range", ifRange);
  return h;
}

// A range guaranteed SATISFIABLE against `size` (size ≥ 1). Covers all three
// RFC forms so the arithmetic property exercises each. We do NOT precompute
// start/end — the property parses them back out of Content-Range and asserts
// invariants, keeping the arithmetic check independent of resolveRange.
function satisfiableRangeArb(size: number): fc.Arbitrary<string> {
  return fc.integer({ min: 0, max: size - 1 }).chain((start) =>
    fc.oneof(
      fc.integer({ min: start, max: size - 1 }).map((end) => `bytes=${start}-${end}`), // closed
      fc.constant(`bytes=${start}-`), // open-ended
      fc.integer({ min: 1, max: size }).map((n) => `bytes=-${n}`), // suffix
    ),
  );
}

// A range guaranteed UNSATISFIABLE against `size` (size ≥ 1).
function unsatisfiableRangeArb(size: number): fc.Arbitrary<string> {
  return fc.oneof(
    fc.constant(`bytes=${size}-`), // start == size
    fc.integer({ min: size, max: size + 100000 }).map((s) => `bytes=${s}-${s + 5}`), // start ≥ size
    fc.constant("bytes=-0"), // suffix length 0
    fc.integer({ min: 1, max: size }).chain((lo) =>
      fc.integer({ min: 0, max: lo - 1 }).map((hi) => `bytes=${lo}-${hi}`),
    ), // inverted start > end (both in-bounds)
  );
}

// A tiny hex-ETag arbitrary (quoted 16-hex, the stable-episode shape).
const hex16 = fc.string({ unit: fc.constantFrom(..."0123456789abcdef".split("")), minLength: 16, maxLength: 16 });
const etagArb = hex16.map((h) => `"${h}"`);

// Header bags of caller policy headers (safe non-empty values, no leading/
// trailing whitespace so Headers normalization can't perturb an equality
// check). Excludes Content-Length / Content-Range: those are module-owned.
const headerVal = fc.string({
  unit: fc.constantFrom(..."abcdefABCDEF0123456789,=-\":;/".split("")),
  minLength: 1,
  maxLength: 24,
});
const policyBagArb = fc.dictionary(
  fc.constantFrom("ETag", "Accept-Ranges", "Cache-Control", "Repr-Digest", "Link", "CDN-Cache-Control", "Vary", "X-Custom"),
  headerVal,
);

// =========================================================================
// 1. Status space + never-throws: for ANY Range on a GET (ignore policy),
//    serveAsset's status tracks resolveRange's verdict exactly and is always
//    in {200, 206, 416}. This subsumes "malformed/absent/ignorable → 200",
//    "inverted → 416", "huge → clamped 206". Oracle read from the SAME header
//    value serveAsset reads, so Headers normalization can't desync them.
// =========================================================================
test("property: status ∈ {200,206,416} and tracks resolveRange for any Range (GET, ignore)", () => {
  fc.assert(
    fc.property(bytesArb, maybeRange, (bytes, range) => {
      const rh = reqHeaders(range);
      const res = serveAsset(sourceOf(bytes), {
        method: "GET",
        requestHeaders: rh,
        headers: {},
        ifRange: { kind: "ignore" },
      });
      expect([200, 206, 416]).toContain(res.status);
      const verdict = resolveRange(rh.get("Range"), bytes.length).kind;
      const expected = verdict === "none" ? 200 : verdict === "satisfiable" ? 206 : 416;
      expect(res.status).toBe(expected);
    }),
    { numRuns: 300 },
  );
});

// =========================================================================
// 2. Malformed / absent / ignorable Range → full 200 body. Focused on the
//    inputs resolveRange calls `none`; asserts no Content-Range and the WHOLE
//    body rides. (Complements #1, which only checks status.)
// =========================================================================
test("property: none-verdict Range → 200 with full body and no Content-Range", async () => {
  await fc.assert(
    fc.asyncProperty(bytesArb, maybeRange, async (bytes, range) => {
      const rh = reqHeaders(range);
      fc.pre(resolveRange(rh.get("Range"), bytes.length).kind === "none");
      const res = serveAsset(sourceOf(bytes), {
        method: "GET",
        requestHeaders: rh,
        headers: {},
        ifRange: { kind: "ignore" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Range")).toBeNull();
      expect(res.headers.get("Content-Length")).toBe(String(bytes.length));
      const body = await bodyBytes(res);
      expect(body.byteLength).toBe(bytes.length);
      expect(body).toEqual(bytes);
    }),
    { numRuns: 200 },
  );
});

// =========================================================================
// 3. 206 arithmetic + body identity. Content-Range is `bytes s-e/size` with
//    0 ≤ s ≤ e < size; Content-Length === e-s+1; body byteLength === e-s+1;
//    body bytes === source.subarray(s, e+1). All three RFC range forms.
// =========================================================================
test("property: 206 Content-Range math and sliced body match the source", async () => {
  await fc.assert(
    fc.asyncProperty(
      bytesArb.chain((bytes) => satisfiableRangeArb(bytes.length).map((range) => ({ bytes, range }))),
      async ({ bytes, range }) => {
        const res = serveAsset(sourceOf(bytes), {
          method: "GET",
          requestHeaders: reqHeaders(range),
          headers: {},
          ifRange: { kind: "ignore" },
        });
        expect(res.status).toBe(206);
        expect(res.statusText).toBe("Partial Content");
        const cr = res.headers.get("Content-Range");
        const m = cr && CONTENT_RANGE_RE.exec(cr);
        expect(m).not.toBeNull();
        const start = Number(m![1]);
        const end = Number(m![2]);
        const size = Number(m![3]);
        expect(size).toBe(bytes.length);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(start).toBeLessThanOrEqual(end);
        expect(end).toBeLessThan(size);
        const len = end - start + 1;
        expect(res.headers.get("Content-Length")).toBe(String(len));
        const body = await bodyBytes(res);
        expect(body.byteLength).toBe(len);
        expect(body).toEqual(bytes.subarray(start, end + 1));
      },
    ),
    { numRuns: 150 },
  );
});

// =========================================================================
// 4. Reconstruction: any partition of [0, size) into adjacent closed ranges
//    yields 206 slices that concatenate BYTE-IDENTICALLY to the full body.
// =========================================================================
test("property: adjacent 206 slices reconstruct the whole representation", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc
        .uint8Array({ minLength: 2, maxLength: 2048 })
        .map((a) => new Uint8Array(a))
        .chain((bytes) =>
          fc
            .uniqueArray(fc.integer({ min: 1, max: bytes.length - 1 }), { maxLength: 6 })
            .map((cuts) => ({ bytes, cuts: [...cuts].sort((a, b) => a - b) })),
        ),
      async ({ bytes, cuts }) => {
        // Boundaries → adjacent [start, end] closed ranges covering [0, size).
        const bounds = [0, ...cuts, bytes.length];
        const parts: Uint8Array[] = [];
        for (let i = 0; i < bounds.length - 1; i++) {
          const start = bounds[i]!;
          const end = bounds[i + 1]! - 1; // inclusive
          const res = serveAsset(sourceOf(bytes), {
            method: "GET",
            requestHeaders: reqHeaders(`bytes=${start}-${end}`),
            headers: {},
            ifRange: { kind: "ignore" },
          });
          expect(res.status).toBe(206);
          parts.push(await bodyBytes(res));
        }
        const joined = new Uint8Array(bytes.length);
        let off = 0;
        for (const p of parts) {
          joined.set(p, off);
          off += p.byteLength;
        }
        expect(off).toBe(bytes.length);
        expect(joined).toEqual(bytes);
      },
    ),
    { numRuns: 60 },
  );
});

// =========================================================================
// 5. 416 iff unsatisfiable: always problem+json, always `Cache-Control:
//    no-store` even when the policy headers say immutable (the 3k audit
//    lock — RFC 9111 cacheable-error risk), Content-Range `bytes */size`,
//    Content-Type/Content-Length NOT the caller's. Policy ETag/others survive.
// =========================================================================
test("property: 416 forces no-store + problem+json even under an immutable policy", async () => {
  await fc.assert(
    fc.asyncProperty(
      bytesArb.chain((bytes) => unsatisfiableRangeArb(bytes.length).map((range) => ({ bytes, range }))),
      etagArb,
      async ({ bytes, range }, etag) => {
        const policy = {
          "Cache-Control": "public, max-age=31536000, immutable",
          ETag: etag,
          "Accept-Ranges": "bytes",
          "Content-Type": "audio/mpeg",
          "Content-Length": String(bytes.length),
        };
        const res = serveAsset(sourceOf(bytes), {
          method: "GET",
          requestHeaders: reqHeaders(range),
          headers: policy,
          ifRange: { kind: "ignore" },
        });
        expect(res.status).toBe(416);
        // The immutable Cache-Control must NEVER ride onto the 416.
        expect(res.headers.get("Cache-Control")).toBe("no-store");
        expect(res.headers.get("Content-Type")).toBe("application/problem+json");
        expect(res.headers.get("Content-Range")).toBe(`bytes */${bytes.length}`);
        // Content-Length is the problem body's own, not the policy's size.
        expect(res.headers.get("Content-Length")).not.toBe(String(bytes.length));
        // Non-owned policy headers survive.
        expect(res.headers.get("ETag")).toBe(etag);
        expect(res.headers.get("Accept-Ranges")).toBe("bytes");
        const doc = (await res.json()) as { type: string; status: number; title: string };
        expect(doc.type).toBe("about:blank");
        expect(doc.status).toBe(416);
        expect(typeof doc.title).toBe("string");
      },
    ),
    { numRuns: 120 },
  );
});

// =========================================================================
// 6. HEAD is never 206 regardless of Range — the runtime strips the body but
//    keeps Content-Length; serveAsset returns the full-bodied 200 shape.
// =========================================================================
test("property: HEAD never yields 206 for any Range", () => {
  fc.assert(
    fc.property(bytesArb, maybeRange, fc.constantFrom("ignore", "strong-etag"), etagArb, (bytes, range, kind, etag) => {
      const res = serveAsset(sourceOf(bytes), {
        method: "HEAD",
        requestHeaders: reqHeaders(range, etag),
        headers: {},
        ifRange: kind === "ignore" ? { kind: "ignore" } : { kind: "strong-etag", etag },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Range")).toBeNull();
      expect(res.headers.get("Content-Length")).toBe(String(bytes.length));
    }),
    { numRuns: 150 },
  );
});

// =========================================================================
// 7a. If-Range "strong-etag": 206 iff the If-Range is absent OR an exact
//     strong ETag match; any mismatch (wrong tag, HTTP-date, null source
//     etag) → full 200. Generated over a satisfiable range so the ONLY thing
//     that can flip 206↔200 is the If-Range decision.
// =========================================================================
test("property: If-Range strong-etag honors Range iff absent-or-exact-match", () => {
  const ifRangeScenario = (etag: string) =>
    fc.oneof(
      fc.constant<{ ifRange: string | null; honor: boolean }>({ ifRange: null, honor: true }), // absent → honor
      fc.constant({ ifRange: etag, honor: true }), // exact match → honor
      fc.constant({ ifRange: "Wed, 21 Oct 2015 07:28:00 GMT", honor: false }), // HTTP-date → 200
      hex16.map((h) => ({ ifRange: `"${h}"`, honor: `"${h}"` === etag })), // usually mismatch
    );
  fc.assert(
    fc.property(
      bytesArb.chain((bytes) =>
        etagArb.chain((etag) =>
          satisfiableRangeArb(bytes.length).chain((range) =>
            ifRangeScenario(etag).map((sc) => ({ bytes, etag, range, sc })),
          ),
        ),
      ),
      ({ bytes, etag, range, sc }) => {
        const res = serveAsset(sourceOf(bytes), {
          method: "GET",
          requestHeaders: reqHeaders(range, sc.ifRange),
          headers: {},
          ifRange: { kind: "strong-etag", etag },
        });
        expect(res.status).toBe(sc.honor ? 206 : 200);
      },
    ),
    { numRuns: 120 },
  );
});

// 7b. strong-etag with a NULL source etag: any present If-Range mismatches ⇒
//     full 200; absent If-Range still honors the Range.
test("property: If-Range strong-etag with null etag → present If-Range forces 200", () => {
  fc.assert(
    fc.property(
      bytesArb.chain((bytes) =>
        satisfiableRangeArb(bytes.length).chain((range) =>
          fc.option(etagArb, { nil: null }).map((ifRange) => ({ bytes, range, ifRange })),
        ),
      ),
      ({ bytes, range, ifRange }) => {
        const res = serveAsset(sourceOf(bytes), {
          method: "GET",
          requestHeaders: reqHeaders(range, ifRange),
          headers: {},
          ifRange: { kind: "strong-etag", etag: null },
        });
        expect(res.status).toBe(ifRange === null ? 206 : 200);
      },
    ),
    { numRuns: 100 },
  );
});

// 7c. If-Range "ignore": 206 regardless of any If-Range value (the row-11
//     20MB-per-seek guard, generalized to arbitrary If-Range strings).
test("property: If-Range ignore honors a satisfiable Range for ANY If-Range", () => {
  fc.assert(
    fc.property(
      bytesArb.chain((bytes) =>
        satisfiableRangeArb(bytes.length).chain((range) =>
          fc.oneof(fc.constant<string | null>(null), etagArb, headerVal).map((ifRange) => ({ bytes, range, ifRange })),
        ),
      ),
      ({ bytes, range, ifRange }) => {
        const res = serveAsset(sourceOf(bytes), {
          method: "GET",
          requestHeaders: reqHeaders(range, ifRange),
          headers: {},
          ifRange: { kind: "ignore" },
        });
        expect(res.status).toBe(206);
      },
    ),
    { numRuns: 100 },
  );
});

// =========================================================================
// 8. Policy-header preservation: caller-supplied headers survive verbatim
//    onto 200 and 206 (module only ADDS Content-Length/Content-Range).
// =========================================================================
test("property: caller policy headers survive unchanged on 200 and 206", () => {
  fc.assert(
    fc.property(
      bytesArb.chain((bytes) =>
        fc
          .option(satisfiableRangeArb(bytes.length), { nil: null })
          .chain((range) => policyBagArb.map((bag) => ({ bytes, range, bag }))),
      ),
      ({ bytes, range, bag }) => {
        const res = serveAsset(sourceOf(bytes), {
          method: "GET",
          requestHeaders: reqHeaders(range),
          headers: bag,
          ifRange: { kind: "ignore" },
        });
        expect(res.status).toBe(range === null ? 200 : 206);
        for (const [k, v] of Object.entries(bag)) {
          expect(res.headers.get(k)).toBe(v);
        }
      },
    ),
    { numRuns: 120 },
  );
});

// =========================================================================
// 9. conditionalNotModified: on a matching If-None-Match it returns a 304
//    that echoes EXACTLY the header bag (RFC 9110 §15.4.5) with a null body;
//    on absent / mismatched / null-etag it returns null (proceed).
// =========================================================================
test("property: conditionalNotModified 304 echoes the header bag with a null body", () => {
  fc.assert(
    fc.property(etagArb, policyBagArb, (etag, bag) => {
      const hit = conditionalNotModified(new Headers({ "If-None-Match": etag }), etag, bag);
      expect(hit).not.toBeNull();
      expect(hit!.status).toBe(304);
      expect(hit!.body).toBeNull();
      for (const [k, v] of Object.entries(bag)) {
        expect(hit!.headers.get(k)).toBe(v);
      }
      // `*` also matches.
      expect(conditionalNotModified(new Headers({ "If-None-Match": "*" }), etag, {})).not.toBeNull();
    }),
    { numRuns: 150 },
  );
});

test("property: conditionalNotModified returns null when it must proceed", () => {
  fc.assert(
    fc.property(etagArb, fc.oneof(fc.constant<string | null>(null), hex16.map((h) => `"${h}z"`)), (etag, mismatch) => {
      // No If-None-Match → proceed.
      expect(conditionalNotModified(new Headers(), etag, {})).toBeNull();
      // Non-matching If-None-Match → proceed (mismatch is 17 chars, never == etag).
      if (mismatch !== null) {
        expect(conditionalNotModified(new Headers({ "If-None-Match": mismatch }), etag, {})).toBeNull();
      }
      // Null source etag → always proceed, even for `*`.
      expect(conditionalNotModified(new Headers({ "If-None-Match": "*" }), null, {})).toBeNull();
    }),
    { numRuns: 100 },
  );
});

// =========================================================================
// 10. stableEpisodeResponseHeaders: the digest/etag gates, generalized over
//     arbitrary slug/ext (the example tests pin single instances).
// =========================================================================
const slugArb = fc.string({ unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-".split("")), minLength: 1, maxLength: 20 });
const extArb = fc.constantFrom("mp3", ".mp3", "m4a", ".m4a", "opus", ".opus", "");

test("property: stableEpisodeResponseHeaders gates ETag on etag and Repr-Digest on a valid sha-256", () => {
  fc.assert(
    fc.property(
      fc.option(etagArb, { nil: null }),
      slugArb,
      extArb,
      fc.oneof(
        fc.constant<string | null | undefined>(undefined),
        fc.constant(null),
        fc.constant("not-a-sha256"), // invalid digest → no Repr-Digest
        fc.string({ unit: fc.constantFrom(..."0123456789abcdef".split("")), minLength: 64, maxLength: 64 }), // valid
      ),
      (etag, slug, ext, digest) => {
        const h = stableEpisodeResponseHeaders({ etag, slug, ext, digest });
        // Always-present base contract.
        expect(h["Cache-Control"]).toBe("no-cache");
        expect(h["Accept-Ranges"]).toBe("bytes");
        expect(h["CDN-Cache-Control"]).toBe("max-age=60, stale-while-revalidate=604800");
        // ETag gate.
        if (etag === null) expect(h["ETag"]).toBeUndefined();
        else expect(h["ETag"]).toBe(etag);
        // Repr-Digest gate: present iff digest is 64-char sha-256 hex.
        const valid = typeof digest === "string" && /^[0-9a-f]{64}$/i.test(digest);
        if (valid) expect(h["Repr-Digest"]).toBe(reprDigestSha256(digest as string));
        else expect(h["Repr-Digest"]).toBeUndefined();
      },
    ),
    { numRuns: 150 },
  );
});
