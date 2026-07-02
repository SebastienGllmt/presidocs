// Slot map for Cloudflare Analytics Engine writes — the single source of
// truth shared between the client beacon (`client/analytics.ts`) and the
// Worker route (`server/analyticsRoute.ts`). See methodology.md → "Engagement
// analytics (Analytics Engine)".
//
// CRITICAL: never edit a slot's meaning in place. Analytics Engine stores
// `{indexes, blobs, doubles}` per row and the slot positions are positional —
// repurposing slot N silently mis-labels every historical row that already
// used slot N for something else. To add a new dimension to an existing event
// type, allocate a NEW slot; to retire one, leave it unused and document why.
//
// Slot layout (every event uses the same positions where applicable):
//   index1 = event-type tag (the WHERE filter in queries)
//   blob1  = post slug ("/" for landing, "/posts/<slug>" for posts)
//   blob2  = event-specific qualifier:
//              narration_play     → PlayTrigger
//              page_view          → referrer hostname (or "")
//              narration_quartile → unused ("")
//   double1 = quartile number (25 | 50 | 75 | 100) for narration_quartile, else 0
//   double2 = audio master-track duration in ms for narration_play, else 0

import "./zodJitless.ts"; // configure jitless before any schema parse (CSP)
import { z } from "zod";

export const EVENT_NAMES = [
  "page_view",
  "narration_play",
  "narration_quartile",
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

// What kicked off the very first play this session, captured by the player
// at the call site and emitted once via narration_play.
export const PLAY_TRIGGERS = [
  "button",
  "space",
  "media-key",
  "chapter",
  "seek",
] as const;
export type PlayTrigger = (typeof PLAY_TRIGGERS)[number];

export const QUARTILES = [25, 50, 75, 100] as const;
export type Quartile = (typeof QUARTILES)[number];

// Wire payloads. Discriminated union on `event` so the Worker route can
// narrow before reading the event-specific fields without `any`.
export type PageViewPayload = {
  event: "page_view";
  post: string;
  referrerHost: string;
};
export type NarrationPlayPayload = {
  event: "narration_play";
  post: string;
  trigger: PlayTrigger;
  durationMs: number;
};
export type NarrationQuartilePayload = {
  event: "narration_quartile";
  post: string;
  quartile: Quartile;
};
export type AnalyticsPayload =
  | PageViewPayload
  | NarrationPlayPayload
  | NarrationQuartilePayload;

// Upper bound on the JSON wire payload. The largest event today
// (narration_play with the longest plausible slug + a 6-character trigger)
// fits well under this; chosen to leave headroom while keeping a reject path
// for runaway inputs. The Worker re-checks this defensively.
export const MAX_PAYLOAD_BYTES = 256;

// Slot positions, named for the call site. Keep these in the same order
// as the slot-layout comment above; the writer maps `blobs[BLOB1_POST] = ...`.
export const BLOB_POST = 0;
export const BLOB_QUALIFIER = 1;
export const DOUBLE_QUARTILE = 0;
export const DOUBLE_DURATION_MS = 1;

// Total slots written per row. Analytics Engine pads/truncates to fit;
// allocating the same widths for every event keeps the schema diff-able and
// every column meaningful for at least one event type.
export const BLOB_COUNT = 2;
export const DOUBLE_COUNT = 2;

// --- Wire-body schema (the JSON the `/_a` beacon POSTs) ---
//
// The single validator the Worker route runs against an untrusted beacon body
// — the JSON-body analog of the query-string validation in
// server/requestSchemas.ts. A `z.discriminatedUnion("event", …)` expresses
// the event ⇄ qualifier relationship directly, and `z.object` strips unknown
// keys so a probe can't smuggle extra fields into a row.
//
// The enums are derived from the SAME frozen `EVENT_NAMES` / `PLAY_TRIGGERS` /
// `QUARTILES` arrays, so there's still one source of truth for the allowlists.
// The per-field `.catch()` normalisations preserve the route's previous lenient
// coercion exactly:
//   - referrerHost: non-string / missing → "", then capped at 253 chars.
//   - durationMs:   non-finite / missing → 0, else max(0, round).
// trigger and quartile are strict — an invalid value rejects the whole body
// (the route then 204s).
const PostField = z.string().min(1);

const PageViewSchema = z.object({
  event: z.literal("page_view"),
  post: PostField,
  referrerHost: z.string().catch("").transform((h) => h.slice(0, 253)),
});
const NarrationPlaySchema = z.object({
  event: z.literal("narration_play"),
  post: PostField,
  trigger: z.enum(PLAY_TRIGGERS),
  durationMs: z
    .number()
    .refine((d) => Number.isFinite(d))
    .transform((d) => Math.max(0, Math.round(d)))
    .catch(0),
});
const NarrationQuartileSchema = z.object({
  event: z.literal("narration_quartile"),
  post: PostField,
  quartile: z.literal(QUARTILES),
});

export const AnalyticsPayloadSchema = z.discriminatedUnion("event", [
  PageViewSchema,
  NarrationPlaySchema,
  NarrationQuartileSchema,
]);
