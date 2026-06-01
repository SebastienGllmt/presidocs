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

export const EVENT_NAMES = [
  "page_view",
  "narration_play",
  "narration_quartile",
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

// The set form is what the Worker route uses for membership tests.
// Frozen so a bug-driven `add()` upstream can't extend the wire allowlist.
export const EVENT_NAME_SET: ReadonlySet<EventName> = new Set(EVENT_NAMES);

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
export const PLAY_TRIGGER_SET: ReadonlySet<PlayTrigger> = new Set(PLAY_TRIGGERS);

export const QUARTILES = [25, 50, 75, 100] as const;
export type Quartile = (typeof QUARTILES)[number];
export const QUARTILE_SET: ReadonlySet<Quartile> = new Set(QUARTILES);

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

// Type-guard helpers. The Worker route uses these to validate input — the
// route is the one boundary between untrusted bytes and `writeDataPoint`,
// so the guards are deliberately narrow.
export function isEventName(s: unknown): s is EventName {
  return typeof s === "string" && EVENT_NAME_SET.has(s as EventName);
}
export function isPlayTrigger(s: unknown): s is PlayTrigger {
  return typeof s === "string" && PLAY_TRIGGER_SET.has(s as PlayTrigger);
}
export function isQuartile(n: unknown): n is Quartile {
  return typeof n === "number" && QUARTILE_SET.has(n as Quartile);
}
