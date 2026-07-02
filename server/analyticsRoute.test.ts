// Regression tests for the analytics route. Focus on the two failure modes
// that are easy to introduce and silent: (a) repurposing a slot position
// (mis-labels every historical row) and (b) loosening the input validation
// (lets bogus events into the dataset).

import { test, expect } from "bun:test";
import { buildDataPoint, isKnownPost, readPayload } from "./analyticsRoute.ts";
import type { PostMetaIndex } from "./postMeta.ts";
import {
  BLOB_COUNT,
  BLOB_POST,
  BLOB_QUALIFIER,
  DOUBLE_COUNT,
  DOUBLE_DURATION_MS,
  DOUBLE_QUARTILE,
  EVENT_NAMES,
} from "../shared/analyticsSchema.ts";

// Stub that knows about exactly one post — the smallest fixture that lets us
// exercise the "valid path" branch without standing up the full meta index.
const postMeta: PostMetaIndex = {
  get(p) {
    return p === "/posts/known" ? { authorEmail: "x@example.com" } : null;
  },
};

function postReq(body: unknown, headers?: Record<string, string>): Request {
  return new Request("https://example.com/_a", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// ---- slot layout -----------------------------------------------------------

test("slot positions are exactly the documented layout", () => {
  // These constants are wire-frozen — see shared/analyticsSchema.ts header.
  // Changing them silently mis-labels every historical row.
  expect(BLOB_POST).toBe(0);
  expect(BLOB_QUALIFIER).toBe(1);
  expect(DOUBLE_QUARTILE).toBe(0);
  expect(DOUBLE_DURATION_MS).toBe(1);
  expect(BLOB_COUNT).toBe(2);
  expect(DOUBLE_COUNT).toBe(2);
});

test("EVENT_NAMES is the closed three-event set", () => {
  // The route allowlist is built from this; loosening it requires a code
  // change here AND in the privacy policy.
  expect([...EVENT_NAMES]).toEqual(["page_view", "narration_play", "narration_quartile"]);
});

// ---- buildDataPoint per event ---------------------------------------------

test("page_view writes post + referrer host", () => {
  const dp = buildDataPoint({
    event: "page_view",
    post: "/posts/known",
    referrerHost: "example.com",
  });
  expect(dp.indexes).toEqual(["page_view"]);
  expect(dp.blobs[BLOB_POST]).toBe("/posts/known");
  expect(dp.blobs[BLOB_QUALIFIER]).toBe("example.com");
  // Doubles unused for page_view — both slots are 0.
  expect(dp.doubles).toEqual([0, 0]);
});

test("narration_play writes post + trigger + duration", () => {
  const dp = buildDataPoint({
    event: "narration_play",
    post: "/posts/known",
    trigger: "space",
    durationMs: 1830000,
  });
  expect(dp.indexes).toEqual(["narration_play"]);
  expect(dp.blobs[BLOB_POST]).toBe("/posts/known");
  expect(dp.blobs[BLOB_QUALIFIER]).toBe("space");
  expect(dp.doubles[DOUBLE_QUARTILE]).toBe(0);
  expect(dp.doubles[DOUBLE_DURATION_MS]).toBe(1830000);
});

test("narration_quartile writes post + quartile", () => {
  const dp = buildDataPoint({
    event: "narration_quartile",
    post: "/posts/known",
    quartile: 50,
  });
  expect(dp.indexes).toEqual(["narration_quartile"]);
  expect(dp.blobs[BLOB_POST]).toBe("/posts/known");
  expect(dp.blobs[BLOB_QUALIFIER]).toBe("");
  expect(dp.doubles[DOUBLE_QUARTILE]).toBe(50);
  expect(dp.doubles[DOUBLE_DURATION_MS]).toBe(0);
});

// ---- readPayload rejections ----------------------------------------------

test("readPayload rejects junk and unknown events", async () => {
  expect(await readPayload(postReq("not json"))).toBeNull();
  expect(await readPayload(postReq({ event: "drop_db" }))).toBeNull();
  expect(await readPayload(postReq({ event: "narration_play" }))).toBeNull(); // missing post
});

test("readPayload truncates oversized payloads via content-length", async () => {
  // A payload whose declared size exceeds the cap is rejected before parsing.
  const big = JSON.stringify({ event: "page_view", post: "/", referrerHost: "x" });
  const req = new Request("https://example.com/_a", {
    method: "POST",
    headers: { "Content-Length": String(10_000) },
    body: big,
  });
  expect(await readPayload(req)).toBeNull();
});

test("readPayload accepts a well-formed narration_quartile", async () => {
  const got = await readPayload(
    postReq({ event: "narration_quartile", post: "/posts/known", quartile: 75 }),
  );
  expect(got).toEqual({
    event: "narration_quartile",
    post: "/posts/known",
    quartile: 75,
  });
});

test("readPayload rejects an invalid trigger / quartile (strict fields)", async () => {
  expect(
    await readPayload(
      postReq({ event: "narration_play", post: "/posts/known", trigger: "dock" }),
    ),
  ).toBeNull();
  expect(
    await readPayload(
      postReq({ event: "narration_quartile", post: "/posts/known", quartile: 33 }),
    ),
  ).toBeNull();
});

test("readPayload strips unknown keys and the discriminated qualifier set", async () => {
  // Extra keys can't smuggle into a row; a narration_quartile body carries
  // only {event, post, quartile} even if the client sends more.
  const got = await readPayload(
    postReq({
      event: "narration_quartile",
      post: "/posts/known",
      quartile: 50,
      trigger: "space", // wrong-event field — must be dropped
      evil: "x",
    }),
  );
  expect(got).toEqual({ event: "narration_quartile", post: "/posts/known", quartile: 50 });
});

test("readPayload preserves the lenient coercion of the old hand-rolled path", async () => {
  // referrerHost: non-string → "" (the MAX_PAYLOAD_BYTES cap, checked earlier
  // in readPayload, makes the 253-char slice an unreachable backstop here, so
  // we exercise the type-coercion half).
  const pv = await readPayload(
    postReq({ event: "page_view", post: "/", referrerHost: 123 }),
  );
  expect(pv).toEqual({ event: "page_view", post: "/", referrerHost: "" });

  // durationMs: non-finite / missing → 0, else max(0, round).
  const np = await readPayload(
    postReq({ event: "narration_play", post: "/", trigger: "space", durationMs: -5.7 }),
  );
  expect(np).toEqual({ event: "narration_play", post: "/", trigger: "space", durationMs: 0 });
  const np2 = await readPayload(
    postReq({ event: "narration_play", post: "/", trigger: "space" }), // missing durationMs
  );
  expect((np2 as { durationMs: number }).durationMs).toBe(0);
  const np3 = await readPayload(
    postReq({ event: "narration_play", post: "/", trigger: "space", durationMs: 1830.4 }),
  );
  expect((np3 as { durationMs: number }).durationMs).toBe(1830);
});

// ---- post allowlist ------------------------------------------------------

test("isKnownPost accepts the landing and known posts only", () => {
  expect(isKnownPost("/", postMeta)).toBe(true);
  expect(isKnownPost("/posts/known", postMeta)).toBe(true);
  expect(isKnownPost("/posts/unknown", postMeta)).toBe(false);
  expect(isKnownPost("/admin", postMeta)).toBe(false);
  expect(isKnownPost("", postMeta)).toBe(false);
});
