// The narration manifest shape, declared ONCE.
//
// `generated/<slug>/manifest.<hash>.json` is THE driving contract: both the
// live narrator (`client/narrator.ts`) and the offline video renderer
// (`generate/render-video.ts`) read it to drive figures, highlights, and
// chapters — page and video must agree. It is produced by `generate/generate.ts`
// and also read by the feed generator (`generate/feeds.ts`). Before this module
// the shape was hand-restated in four places that had already drifted (the
// narrator's `{audio,duration,chapters,marks}`, the renderer's `{slug,...}`,
// feeds' `{audio?,duration?,chapters?,audioDigest?}`, plus the producer's
// inline literals). Here it is declared once; `z.infer` gives every consumer
// the same type, so a producer↔consumer field drift is a compile error.
//
// SCOPE: this is a TYPE/VALIDATION layer only — it is NOT the serializer.
// `generate.ts` keeps owning the write verbatim (its conditional spreads keep
// absent keys ABSENT, not `: undefined`, which protects the byte-identical
// manifest-name cache invariant — methodology → "Audio caching"). Routing the
// write through `z` would flip absent keys to present and bust every cached
// manifest, so we never do that.
//
// `Milliseconds` brand: the producer and narrator carry a branded
// `Milliseconds` on every time field; the schema reuses `MillisecondsSchema`
// (shared/time.ts) so that brand is preserved end-to-end. The renderer and
// feeds read those fields as plain numbers — a branded `Milliseconds` widens to
// `number`, so their arithmetic is unaffected.

import "./zodJitless.ts"; // configure jitless before any parse (CSP / Workers no-eval)
import { z } from "zod";
import { MillisecondsSchema } from "./time.ts";

// Per-word timing inside a mark. `s`/`e` are character offsets into the mark's
// displayed `text`; `t`/`d` are master-track absolute ms.
export const ManifestWordSchema = z.object({
  s: z.number().int(),
  e: z.number().int(),
  t: MillisecondsSchema,
  d: MillisecondsSchema,
});
export type ManifestWord = z.infer<typeof ManifestWordSchema>;

export const ManifestMarkSchema = z.object({
  name: z.string(),
  time: MillisecondsSchema,
  chapter: z.string(),
  // The spoken text following this mark (always emitted by the producer).
  text: z.string(),
  // Per-word karaoke timing; absent when the post was generated without forced
  // alignment.
  words: z.array(ManifestWordSchema).optional(),
  // Figure-staging pointer (which figure is on the stage during this segment);
  // absent leaves the stage unchanged. The producer omits the key entirely for
  // un-annotated marks (cache invariant), so it is `.optional()`, not nullable.
  figure: z.string().optional(),
  // Per-step slideshow pointer; same conditional-omit semantics as `figure`.
  step: z.string().optional(),
});
export type ManifestMark = z.infer<typeof ManifestMarkSchema>;

// A flat, leaf-only chapter entry. `parentId` (level-2 chapters only) names the
// level-1 chapter they group under; absent → a top-level chapter.
export const ManifestChapterSchema = z.object({
  id: z.string(),
  title: z.string(),
  startTime: MillisecondsSchema,
  endTime: MillisecondsSchema,
  parentId: z.string().optional(),
});
export type ManifestChapter = z.infer<typeof ManifestChapterSchema>;

export const ManifestSchema = z.object({
  // Post slug. On the JSON (the producer writes it); the video renderer reads
  // it back into its render plan.
  slug: z.string(),
  audio: z.string(),
  // Full SHA-256 hex of the audio bytes. Metadata, not narration-driving: only
  // feeds reads it (for podcast:integrity), and it guards its own presence —
  // so it's `.optional()` here, tolerating an older manifest that predates it.
  audioDigest: z.string().optional(),
  duration: MillisecondsSchema,
  chapters: z.array(ManifestChapterSchema),
  marks: z.array(ManifestMarkSchema),
});
// The producer also writes `generatedAt` and a `provenance` block; no consumer
// reads them through this type, so they're left unmodeled (a bare `z.object`
// strips them on parse, which is harmless on the read-only path — and the
// schema never serializes, so it can't drop them from the on-disk file).
export type Manifest = z.infer<typeof ManifestSchema>;
