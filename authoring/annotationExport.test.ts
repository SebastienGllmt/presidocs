import { test, expect } from "bun:test";
import {
  makeTextTarget,
  makeGraphicTarget,
  type Reply,
  type Thread,
} from "../client/commentsStore.ts";
import {
  ANNO_JSONLD_CONTEXT,
  snapshotToAnnotationCollection,
  threadToAnnotation,
} from "./annotationExport.ts";

function reply(over: Partial<Reply> = {}): Reply {
  return {
    id: "r1",
    body: "Looks good",
    createdAt: 1_700_000_000_000,
    authorId: "google:42",
    authorName: "Ada",
    authorEmail: "ada@example.com",
    ...over,
  };
}

const TEXT_THREAD: Thread = {
  id: "t1",
  target: makeTextTarget({
    context: "article",
    blocks: [{ id: "id:intro", hash: "h1" }],
    startOffset: 3,
    endOffset: 9,
    quote: "lorem",
  }),
  replies: [reply()],
  createdAt: 1_700_000_000_000,
};

const opts = { slug: "hash-functions", baseIri: "/posts/hash-functions" };

test("text thread becomes a commenting Annotation", () => {
  const anno = threadToAnnotation(TEXT_THREAD, opts)!;
  expect(anno["@context"]).toBe(ANNO_JSONLD_CONTEXT);
  expect(anno.type).toBe("Annotation");
  expect(anno.motivation).toBe("commenting");
  expect(anno.id).toBe("urn:blog:hash-functions:thread:t1");
  expect(anno.created).toBe(new Date(1_700_000_000_000).toISOString());
  // target source resolved against the post base
  expect(anno.target.source).toBe("/posts/hash-functions");
});

test("narration source resolves to a #narration fragment", () => {
  const t: Thread = {
    ...TEXT_THREAD,
    target: makeTextTarget({
      context: "narration",
      blocks: [{ id: "id:intro", hash: "h1" }],
      startOffset: 0,
      endOffset: 4,
      quote: "test",
    }),
  };
  const anno = threadToAnnotation(t, opts)!;
  expect(anno.target.source).toBe("/posts/hash-functions#narration");
});

test("reply becomes a TextualBody and drops the email", () => {
  const anno = threadToAnnotation(TEXT_THREAD, opts)!;
  expect(anno.body.length).toBe(1);
  const body = anno.body[0]!;
  expect(body.type).toBe("TextualBody");
  expect(body.value).toBe("Looks good");
  expect(body.format).toBe("text/markdown");
  expect(body.creator).toEqual({ type: "Person", id: "google:42", name: "Ada" });
  // email must never appear anywhere in the serialized annotation
  expect(JSON.stringify(anno)).not.toContain("ada@example.com");
});

test("resolved threads carry an x-blog:resolvedAt extension", () => {
  const resolved: Thread = { ...TEXT_THREAD, resolvedAt: 1_700_000_500_000 };
  const anno = threadToAnnotation(resolved, opts)!;
  expect(anno["x-blog:resolvedAt"]).toBe(
    new Date(1_700_000_500_000).toISOString(),
  );
});

test("threads with no visible replies are skipped", () => {
  const empty: Thread = { ...TEXT_THREAD, replies: [] };
  expect(threadToAnnotation(empty, opts)).toBeNull();

  const deleted: Thread = {
    ...TEXT_THREAD,
    replies: [reply({ deletedAt: 1_700_000_100_000 })],
  };
  expect(threadToAnnotation(deleted, opts)).toBeNull();
});

test("narration audio range exports as a native Media Fragments selector", () => {
  const t: Thread = {
    id: "n1",
    target: makeTextTarget({
      context: "narration",
      blocks: [{ id: "id:lede", hash: "h1" }],
      startOffset: 0,
      endOffset: 5,
      quote: "Hello",
      audioRange: { startMs: 2868, endMs: 8838 },
    }),
    replies: [reply()],
    createdAt: 1_700_000_000_000,
  };
  const anno = threadToAnnotation(t, opts)!;
  const selectors = anno.target.selector as Array<Record<string, unknown>>;
  const media = selectors.find((s) => s.conformsTo);
  expect(media).toEqual({
    type: "FragmentSelector",
    conformsTo: "http://www.w3.org/TR/media-frags/",
    value: "t=2.868,8.838",
  });
});

test("graphic target survives the round-trip into the collection", () => {
  const g: Thread = {
    id: "g1",
    target: makeGraphicTarget("article", "id:diagram"),
    replies: [reply({ id: "rg" })],
    createdAt: 1_700_000_000_001,
  };
  const coll = snapshotToAnnotationCollection([TEXT_THREAD, g], opts);
  expect(coll.type).toBe("AnnotationCollection");
  expect(coll.total).toBe(2);
  expect(coll.items.length).toBe(2);
  // FragmentSelector value is the bare HTML fragment id (no `id:` prefix)
  const gAnno = coll.items.find((a) => a.id.endsWith(":thread:g1"))!;
  expect(gAnno.target.selector).toEqual({
    type: "FragmentSelector",
    value: "diagram",
  });
});

test("x-blog:origin rides on annotation and bodies when origins are passed", () => {
  const anno = threadToAnnotation(TEXT_THREAD, opts, {
    thread: "production",
    replies: { r1: "localhost" },
  })!;
  expect(anno["x-blog:origin"]).toBe("production");
  expect(anno.body[0]!["x-blog:origin"]).toBe("localhost");

  const viaCollection = snapshotToAnnotationCollection(
    [TEXT_THREAD],
    opts,
    new Map([["t1", { thread: "production" as const, replies: {} }]]),
  );
  expect(viaCollection.items[0]!["x-blog:origin"]).toBe("production");
  // A reply id absent from the origins map gets no extension.
  expect("x-blog:origin" in viaCollection.items[0]!.body[0]!).toBe(false);
});

test("x-blog:origin is omitted entirely when origins are not passed (browser caller)", () => {
  const anno = threadToAnnotation(TEXT_THREAD, opts)!;
  expect("x-blog:origin" in anno).toBe(false);
  expect("x-blog:origin" in anno.body[0]!).toBe(false);
  const coll = snapshotToAnnotationCollection([TEXT_THREAD], opts);
  expect("x-blog:origin" in coll.items[0]!).toBe(false);
});
