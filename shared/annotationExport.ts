// Phase B of the Web Annotation adoption (methodology.md → Comments →
// "Exporting to the Web Annotation wire format"): turn the in-memory
// comment snapshot — which is *already* shaped around WA selectors
// after Phase A — into spec-valid JSON-LD `Annotation` documents and an
// `AnnotationCollection` wrapping them.
//
// This is a pure transform: snapshot threads in, JSON-LD objects out.
// It runs wherever a merged snapshot is available — the author's browser
// (already merges every reader's blob via the aggregator) or the offline
// authoring tools (`authoring/exportAnnotations.ts`). It is deliberately
// NOT a Worker route: emitting a *merged* collection means running
// Automerge server-side to combine per-user blobs, which would forfeit
// the dumb-server rule that production depends on (see methodology.md →
// "dumb-server is a production constraint"). The dumb server only ever
// shuffles opaque change-bytes; the merge + serialize step lives on the
// client and in local Bun tooling, where running Automerge is fine.
//
// What the transform does to bridge our types to the spec:
//   - `Thread`        → `Annotation` (`motivation: "commenting"`).
//   - `Reply[]`       → `body: TextualBody[]` (format text/markdown).
//   - `Reply.author*` → `creator` (a FOAF-ish Person); `authorEmail` is
//     *dropped* — it's author-eyes-only follow-up data and has no place
//     in a portable export (methodology.md → Comments → Author identity).
//   - storage `source` ("" / "#narration") → a real IRI resolved against
//     the post's base.
//   - non-WA fields become project extensions: `x-blog:resolvedAt` and
//     the `x-blog:segmentHashes` already carried inside the target.

import {
  contextOf,
  isResolved,
  visibleReplies,
  type Reply,
  type Target,
  type Thread,
} from "../client/commentsStore.ts";

export const ANNO_JSONLD_CONTEXT = "http://www.w3.org/ns/anno.jsonld";

export type Person = {
  type: "Person";
  id: string;
  name: string;
};

export type TextualBody = {
  id: string;
  type: "TextualBody";
  value: string;
  format: "text/markdown";
  creator: Person;
  created: string;
};

export type Annotation = {
  "@context": typeof ANNO_JSONLD_CONTEXT;
  id: string;
  type: "Annotation";
  motivation: "commenting";
  created: string;
  body: TextualBody[];
  target: Target;
  "x-blog:resolvedAt"?: string;
};

export type AnnotationCollection = {
  "@context": typeof ANNO_JSONLD_CONTEXT;
  id: string;
  type: "AnnotationCollection";
  total: number;
  items: Annotation[];
};

export type ExportOptions = {
  /**
   * Stable id namespace for the post — used to mint annotation IRIs of
   * the form `urn:blog:<slug>:thread:<id>`. We use a `urn:` scheme (not
   * `urn:uuid:`) because our ids come from `uid()`, not RFC-4122 UUIDs;
   * claiming `urn:uuid:` would be a lie a strict consumer could reject.
   */
  slug: string;
  /**
   * IRI the target `source` is resolved against. Pass the post's path
   * (`/posts/<slug>`) for a relative export, or a full
   * `https://…/posts/<slug>` URL for an absolute, portable one.
   */
  baseIri: string;
};

function annotationId(opts: ExportOptions, threadId: string): string {
  return `urn:blog:${opts.slug}:thread:${threadId}`;
}

function bodyId(opts: ExportOptions, replyId: string): string {
  return `urn:blog:${opts.slug}:reply:${replyId}`;
}

// Resolve the storage-relative `source` ("" or "#narration") against the
// post base, and clone the target so the export never aliases live CRDT
// state. `x-blog:segmentHashes` rides along untouched — it's already a
// valid project-namespaced extension.
function exportTarget(opts: ExportOptions, target: Target): Target {
  const clone = structuredClone(target);
  const fragment = contextOf(target) === "narration" ? "#narration" : "";
  clone.source = `${opts.baseIri}${fragment}`;
  return clone;
}

function replyToBody(opts: ExportOptions, reply: Reply): TextualBody {
  return {
    id: bodyId(opts, reply.id),
    type: "TextualBody",
    value: reply.body,
    format: "text/markdown",
    creator: {
      type: "Person",
      id: reply.authorId,
      name: reply.authorName,
      // authorEmail intentionally omitted — see file header.
    },
    created: new Date(reply.createdAt).toISOString(),
  };
}

/**
 * Serialize one thread to a WA `Annotation`, or `null` if it has no
 * visible (non-tombstoned) replies — an empty annotation has nothing to
 * say and isn't worth emitting.
 */
export function threadToAnnotation(
  thread: Thread,
  opts: ExportOptions,
): Annotation | null {
  const replies = visibleReplies(thread);
  if (replies.length === 0) return null;
  const annotation: Annotation = {
    "@context": ANNO_JSONLD_CONTEXT,
    id: annotationId(opts, thread.id),
    type: "Annotation",
    motivation: "commenting",
    created: new Date(thread.createdAt).toISOString(),
    body: replies.map((r) => replyToBody(opts, r)),
    target: exportTarget(opts, thread.target),
  };
  if (isResolved(thread)) {
    annotation["x-blog:resolvedAt"] = new Date(thread.resolvedAt!).toISOString();
  }
  return annotation;
}

/**
 * Serialize a whole snapshot to a WA `AnnotationCollection`. Threads
 * with no visible replies are skipped.
 */
export function snapshotToAnnotationCollection(
  threads: Thread[],
  opts: ExportOptions,
): AnnotationCollection {
  const items = threads
    .map((t) => threadToAnnotation(t, opts))
    .filter((a): a is Annotation => a !== null);
  return {
    "@context": ANNO_JSONLD_CONTEXT,
    id: `urn:blog:${opts.slug}:annotations`,
    type: "AnnotationCollection",
    total: items.length,
    items,
  };
}
