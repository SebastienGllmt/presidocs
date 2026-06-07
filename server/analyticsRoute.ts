// Engagement analytics sink (Cloudflare Analytics Engine). Accepts a tiny,
// fixed-schema beacon from `client/analytics.ts` and writes one data point per
// valid event. See methodology.md → "Engagement analytics (Analytics Engine)".
//
// Design properties this handler upholds — call them out so a future edit
// doesn't quietly break them:
//   - Anonymous: no cookie / userId / IP gets written. The event blobs/doubles
//     above are the entire payload; nothing about the *visitor* lands here.
//   - Always 204: any rejected payload (bad JSON, unknown event, oversize,
//     bot-flagged) returns `204 No Content` so a probe can't discover valid
//     post slugs by response code. The legitimate client doesn't read the
//     response anyway (fire-and-forget via `navigator.sendBeacon`).
//   - Bot-filtered at the edge: a UA-regex pattern catches the long tail
//     (common crawler/bot strings) and an empty-UA check drops automation
//     that didn't bother to spoof one. On Enterprise-tier zones with Bot
//     Management we *also* read `request.cf.botManagement.verifiedBot` and
//     `request.cf.verifiedBotCategory` to drop verified good bots cleanly —
//     but those fields are only populated on the Enterprise Bot Management
//     add-on (see Cloudflare docs → bot-management-variables). On a free /
//     Pro / Business zone both are `undefined`, so the UA regex is the sole
//     active filter; we accept that — the false-negative cost is one extra
//     row of cheap, anonymous data, not a privacy issue.
//   - Coupling-safe vs the comments layer: this handler reads no comment
//     state and writes none. Even on the same Worker the analytics surface
//     can't accidentally couple to the per-user R2 CRDT bytes
//     (`createWorker.ts` is the dumb edge — see methodology.md).
//
// Mounted at `POST /_a` from both `createDevServer.ts` and `createWorker.ts`.
// The path is short on purpose: every page emit pays the URL bytes, so we
// hold to "two characters + slash" rather than e.g. `/analytics`.

import type { PostMetaIndex } from "./postMeta.ts";
// Official Workers binding types (types-only devDep, erased at build) — the same
// `AnalyticsEngineDataset`/`RateLimit` `server/env.ts` types the bindings with,
// so the handler consumes the exact contract the platform guarantees instead of
// a narrower hand-declared duplicate.
import type { AnalyticsEngineDataset, RateLimit } from "@cloudflare/workers-types";
import { StatusCodes } from "http-status-codes";
import {
  AnalyticsPayloadSchema,
  BLOB_COUNT,
  BLOB_POST,
  BLOB_QUALIFIER,
  DOUBLE_COUNT,
  DOUBLE_DURATION_MS,
  DOUBLE_QUARTILE,
  MAX_PAYLOAD_BYTES,
  type AnalyticsPayload,
} from "../shared/analyticsSchema.ts";

export type AnalyticsDeps = {
  // The Analytics Engine binding from the Worker (`env.ANALYTICS`), or null
  // in dev. A null sink turns every emit into a no-op while keeping the route
  // alive — no client-visible difference, no warnings on every request. The
  // official `AnalyticsEngineDataset` type (accepts `(ArrayBuffer|string|null)[]`
  // blobs/indexes) is wider than what we write today; `buildDataPoint` keeps the
  // narrow `string[]` shape and `analyticsSchema.ts` stays the only source of
  // positional slot meaning.
  sink: AnalyticsEngineDataset | null;
  // Same `postMetaIndex` the comments + version routes use, for the
  // allowlist check on `post`. The landing path is allowed in addition.
  postMeta: PostMetaIndex;
  // Workers Rate Limiting binding (prod) or null (dev). Keyed on edge IP so
  // a flood from one source can't drown the dataset.
  rateLimiter: RateLimit | null;
};

// Reasonable upper bound on a known good crawler's UA string for early
// exit; deliberately not anchored — many crawler UAs append a URL or
// version after the keyword.
const BOT_UA_PATTERN = /bot|crawl|spider|prerender|headless|preview|monitor/i;

// Read the client IP for rate-limit keying — same header Cloudflare sets at
// the edge. In dev (no edge), fall back to a constant so the rate limiter
// (if any) treats all dev requests as one key, which is exactly what we want.
function clientKey(req: Request): string {
  return req.headers.get("CF-Connecting-IP") ?? req.headers.get("X-Forwarded-For") ?? "dev";
}

// `request.cf` is present on Cloudflare's runtime, absent in Bun dev. The
// `botManagement.verifiedBot` / `verifiedBotCategory` fields are *only*
// populated on Enterprise zones with the Bot Management add-on — on
// free/Pro/Business they're always undefined and the function falls through
// to the UA checks. That's fine: the UA regex catches common crawlers, the
// empty-UA branch catches naive automation, and the row-cost of a missed bot
// is one anonymous beacon — not a privacy or correctness issue.
type CfRequest = Request & {
  cf?: {
    verifiedBotCategory?: string;
    botManagement?: { verifiedBot?: boolean };
  };
};
function isBot(req: Request): boolean {
  const cf = (req as CfRequest).cf;
  // Enterprise Bot Management signals first (cheap when present, no-op when not).
  if (cf?.botManagement?.verifiedBot) return true;
  if (cf?.verifiedBotCategory) return true;
  const ua = req.headers.get("user-agent");
  // Missing/empty UA — almost always automation that didn't bother to fake
  // one. A real browser always sends a non-empty UA, even in privacy modes.
  if (!ua) return true;
  return BOT_UA_PATTERN.test(ua);
}

// Parse + validate the JSON body. Returns `null` on any failure (the route
// then 204s). Cap the read at `MAX_PAYLOAD_BYTES` so a malicious actor can't
// stream a multi-MB body and force us to buffer it.
async function readPayload(req: Request): Promise<AnalyticsPayload | null> {
  const cl = req.headers.get("content-length");
  if (cl && Number(cl) > MAX_PAYLOAD_BYTES) return null;
  let text: string;
  try {
    text = await req.text();
  } catch {
    return null;
  }
  if (text.length > MAX_PAYLOAD_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  // One declarative parse replaces the per-event `if` ladder. The schema
  // strips unknown keys, enforces the event ⇄ qualifier shape, and applies the
  // same lenient coercion the route did by hand (see analyticsSchema.ts). The
  // `post` allowlist (landing or known post path) stays a SEMANTIC guard in
  // the handler — checked against postMeta after this returns.
  const result = AnalyticsPayloadSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

// `post` must be either the landing ("/") OR a known post path. Anything
// else is dropped — bogus paths would waste storage and split queries
// across phantom keys. This is the *only* dimension a client controls,
// so it's the one allowlist that has to hold.
function isKnownPost(post: string, postMeta: PostMetaIndex): boolean {
  if (post === "/") return true;
  return postMeta.get(post) !== null;
}

// Map a validated payload into the positional slot layout from
// `analyticsSchema.ts`. The slot positions live in one place; this is the
// single writer that depends on them.
function buildDataPoint(payload: AnalyticsPayload): {
  indexes: string[];
  blobs: string[];
  doubles: number[];
} {
  const blobs: string[] = new Array(BLOB_COUNT).fill("");
  const doubles: number[] = new Array(DOUBLE_COUNT).fill(0);
  blobs[BLOB_POST] = payload.post;
  if (payload.event === "page_view") {
    blobs[BLOB_QUALIFIER] = payload.referrerHost;
  } else if (payload.event === "narration_play") {
    blobs[BLOB_QUALIFIER] = payload.trigger;
    doubles[DOUBLE_DURATION_MS] = payload.durationMs;
  } else {
    doubles[DOUBLE_QUARTILE] = payload.quartile;
  }
  return { indexes: [payload.event], blobs, doubles };
}

// All paths through the handler return 204 — see the file header for why.
const NO_CONTENT = (): Response => new Response(null, { status: StatusCodes.NO_CONTENT });

export async function handleAnalyticsRequest(
  req: Request,
  deps: AnalyticsDeps,
): Promise<Response> {
  if (req.method !== "POST") return NO_CONTENT();

  // Edge bot filter runs FIRST, before any IO. Known crawlers shouldn't even
  // burn rate-limit budget.
  if (isBot(req)) return NO_CONTENT();

  if (deps.rateLimiter) {
    const { success } = await deps.rateLimiter.limit({ key: clientKey(req) });
    if (!success) return NO_CONTENT();
  }

  const payload = await readPayload(req);
  if (!payload) return NO_CONTENT();
  if (!isKnownPost(payload.post, deps.postMeta)) return NO_CONTENT();

  if (deps.sink) {
    deps.sink.writeDataPoint(buildDataPoint(payload));
  }
  return NO_CONTENT();
}

// Exposed for tests — same posture as `comments/routes.ts:MAX_CHANGE_BYTES`.
export { buildDataPoint, readPayload, isKnownPost, isBot };
