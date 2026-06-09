// Single source of truth for every JSON shape the comment / resolution data
// crosses a boundary in — the network (client ⇄ server), the privileged sync
// worker (CLI ⇄ throwaway worker), and the local dev store (CLI writer ⇄
// reader). Importable by `client/`, `server/`, and `authoring/` alike.
//
// Before this module each shape was either trusted via an unchecked `as` cast
// at the boundary or re-stated by hand in two or three places that could drift
// independently. Here a shape is declared ONCE; each consumer validates at its
// own edge. zod is already in the client bundle
// (shared/time.ts pulls it in), so client-side validation costs no bundle
// weight — only code.
//
// Scope is SHAPE only. Semantic/security guards (the PUT fence, the byte caps,
// per-method authz, the post allowlist) stay in their handlers — a schema must
// never stand in for them (the proposal-26 lesson, restated). And the binary
// Automerge change blobs stay opaque end-to-end: they are content-addressed
// CRDT bytes with no JSON shape to validate, so zod would be a category error.

import "./zodJitless.ts"; // configure jitless before any schema parse (CSP)
import { z } from "zod";

// --- Field primitives (the request side composes these in requestSchemas.ts) ---

// `post` is an opaque post path/key (e.g. "/posts/foo"); non-empty is the only
// shape rule — the store treats it as an opaque key.
export const PostPath = z.string().min(1);

// Reader identity is "<provider>:<sub>"; providers are exactly google or
// microsoft (see methodology → Reader identity). Validating the prefix keeps a
// malformed value from ever reaching a content-addressed store key.
export const UserId = z.string().regex(/^(google|microsoft):.+$/);

// Automerge change hash: lowercase hex sha-256, 64 chars. Doubles as an R2
// object key, so pinning the shape is a small hardening win too.
export const ChangeHash = z.string().regex(/^[0-9a-f]{64}$/);

// Thread id is an opaque random string; non-empty is the only shape rule.
export const ThreadId = z.string().min(1);

// --- Wire shapes ---
//
// `uploaded` / `builtAt` are ISO-8601 STRINGS on the wire. The server store
// keeps them as `Date` internally (see server/comments/store.ts) and
// `Response.json` serializes the Date to an ISO string in transit — so the
// wire schema is deliberately `z.string()`, NOT a date. The store's own
// `Date`-typed entry stays where it is; this module models only what crosses
// the boundary.
//
// Deliberately NOT a `z.codec(z.iso.datetime(), z.date(), …)` (Zod 4's
// string⇄Date bridge): the string IS the right client representation here, not
// an artifact to decode away. The client consumes `uploaded` as a localStorage
// equality key (resolutionsStore) and `builtAt` as an HTML `<time datetime>`
// attribute (comments.ts) — both want the string; the one Date-formatted
// display builds `new Date(builtAt)` on the spot. And the encode direction is
// already free (`Response.json` → `Date.toJSON()`), so a codec would route
// through nothing, while making `.parse()` silently hand back Dates. Reach for
// `z.codec` only if a future field is genuinely *consumed* as a Date/bigint/Map
// — then the conversion belongs exactly once, at the boundary.
//
// `z.object` strips unknown keys by default, so an *additive* server field
// never breaks an older client — important for an engine deployed across
// content repos that update on their own cadence.

// Declared birth store of a comment change blob. Carried as optional
// provenance metadata end-to-end (PUT query param → store metadata → LIST
// entry): one uniform rule — a store exposes it iff the stored object
// carries it, a consumer renders it iff present. Today only the seeding
// CLI declares it (origin=production on blobs it copies into the dev
// store); browser writes never do, so prod entries simply never have it.
export const ChangeOrigin = z.enum(["production", "localhost"]);
export type ChangeOrigin = z.infer<typeof ChangeOrigin>;

export const ChangeListEntry = z.object({
  hash: ChangeHash,
  size: z.number().int(),
  uploaded: z.string(),
  origin: ChangeOrigin.optional(),
});
export type ChangeListEntry = z.infer<typeof ChangeListEntry>;

// GET /comments?post&user — the change listing for one user.
export const ChangeList = z.array(ChangeListEntry);

// GET /comments?post — the author-only listing of userIds with any change.
export const CommentUsers = z.array(z.string());

export const ResolutionListEntry = z.object({
  threadId: ThreadId,
  size: z.number().int(),
  uploaded: z.string(),
});
export type ResolutionListEntry = z.infer<typeof ResolutionListEntry>;

// GET /resolutions?post — the listing of resolved threads.
export const ResolutionList = z.array(ResolutionListEntry);

// The resolution body. Written by BOTH the in-browser author (putResolution)
// and the `ai-applied` CLI (authoring/resolveThreads.ts), and read back by the
// browser (getResolution). One schema makes those writers provably agree.
//
// `resolverId` is deliberately looser than `UserId`: a resolution can be
// written by an OAuth user (`<provider>:<sub>`) OR by the `ai-applied`
// sentinel, so it is a plain string, not a `UserId`.
export const ResolutionEnvelope = z.object({
  threadId: ThreadId,
  resolvedAt: z.number().int(),
  resolverId: z.string(),
  resolverName: z.string(),
});
export type ResolutionEnvelope = z.infer<typeof ResolutionEnvelope>;

// The resolutions cache shape as persisted to localStorage by
// `client/resolutionsStore.ts` (a `Record<threadId, CachedResolution>`).
// localStorage is a real trust boundary here — it's per-origin (another script
// on the origin can write the key) and the engine ships into multiple content
// repos that update on their own cadence, so a stale entry written by an older
// engine version is a realistic source of a wrong shape. Composing the existing
// `ResolutionEnvelope` (rather than re-stating it) keeps the cached shape and
// the wire shape provably one definition; the store `safeParse`s on read so a
// malformed cache drops to the re-fetch path instead of flowing on as a typed
// value.
export const CachedResolution = z.object({
  // ISO upload timestamp of the LIST entry, used to detect changes without
  // re-GETing the body.
  uploadedAt: z.string(),
  envelope: ResolutionEnvelope,
});
export type CachedResolution = z.infer<typeof CachedResolution>;

export const CachedResolutions = z.record(z.string(), CachedResolution);

export const PostVersionEntry = z.object({
  hash: z.string(),
  builtAt: z.string(), // ISO 8601
});
export type PostVersionEntry = z.infer<typeof PostVersionEntry>;

export const PostVersionResponse = z.object({
  currentHash: z.string(),
  isAuthor: z.boolean(),
  // Only present when isAuthor === true.
  history: z.array(PostVersionEntry).optional(),
});
export type PostVersionResponse = z.infer<typeof PostVersionResponse>;

// --- Privileged sync listing (authoring/r2SyncWorker.ts `/list`) ---
//
// The throwaway worker lists raw R2 keys (not threadIds/hashes), so this is a
// distinct shape from the gated-route listings above.
export const R2ListEntry = z.object({
  key: z.string(),
  size: z.number().int(),
  uploaded: z.string(),
});
export type R2ListEntry = z.infer<typeof R2ListEntry>;
