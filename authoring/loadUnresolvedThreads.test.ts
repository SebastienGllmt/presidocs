// Origin attribution in the offline loader: per-blob `.src` provenance
// stamps → per-thread/per-reply origins via subset replay. Builds a real
// Automerge fixture in a temp store: three changes by one user —
// production-stamped (thread A + reply), unstamped/pre-provenance
// (thread C + reply), localhost-stamped (reply to A + thread B + reply).
// The reply-to-A models the spanning case the design exists for: a
// production-born thread carrying a localhost-born author reply.
//
// Change order mirrors reality: unknown (pre-stamping era) changes are
// causally BEFORE localhost-stamped ones, so the production+unknown
// subset replay is dep-closed (see the loader's attribution comment).

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { initializeWasm, isWasmInitialized } from "@automerge/automerge/slim";
import * as Automerge from "@automerge/automerge/slim";
import { changeKey } from "../server/comments/store.ts";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import {
  makeTextTarget,
  SEED_BYTES_B64,
  type Reply,
  type Suggestion,
  type Target,
} from "../client/commentsStore.ts";
import { loadUnresolvedThreads } from "./loadUnresolvedThreads.ts";

// Mirror of the loader's CRDT-internal shape (see its header comment on
// why this is duplicated rather than imported).
type StoredThread = {
  target: Target;
  createdAt: number;
  resolvedAt?: number;
  suggestion?: Suggestion;
};
type StoredReply = Reply & { threadId: string };
type CommentDoc = {
  threads: { [id: string]: StoredThread };
  replies: { [replyId: string]: StoredReply };
};

const POST_PATH = "/posts/origin-test";
const USER = "google:fixture-user";

function target(quote: string): Target {
  return makeTextTarget({
    context: "article",
    blocks: [{ id: "id:intro", hash: "h1" }],
    startOffset: 0,
    endOffset: quote.length,
    quote,
  });
}

function reply(id: string, threadId: string, body: string): StoredReply {
  return {
    id,
    threadId,
    body,
    createdAt: 1_700_000_000_000,
    authorId: USER,
    authorName: "Fixture",
    authorEmail: "fixture@example.com",
  };
}

test("subset replay attributes thread and reply origins from blob stamps", async () => {
  if (!isWasmInitialized()) {
    const bytes = await Bun.file(resolveBlogPaths().automergeWasm).arrayBuffer();
    await initializeWasm(new Uint8Array(bytes));
  }
  const commentsDir = await mkdtemp(join(tmpdir(), "origin-test-"));

  // Build one user's change history off the shared seed.
  let doc = Automerge.load<CommentDoc>(Uint8Array.fromBase64(SEED_BYTES_B64));
  const changes: { bytes: Uint8Array; stamp: "production" | "localhost" | null }[] = [];
  const record = (next: Automerge.Doc<CommentDoc>, stamp: "production" | "localhost" | null) => {
    changes.push({ bytes: Automerge.getLastLocalChange(next)!, stamp });
    doc = next;
  };

  // 1) production: thread A + its first reply (reader feedback on prod).
  record(
    Automerge.change(doc, (d) => {
      d.threads["tA"] = { target: target("alpha"), createdAt: 1 };
      d.replies["rA1"] = reply("rA1", "tA", "prod feedback");
    }),
    "production",
  );
  // 2) unstamped: pre-provenance thread C + reply.
  record(
    Automerge.change(doc, (d) => {
      d.threads["tC"] = { target: target("gamma"), createdAt: 2 };
      d.replies["rC1"] = reply("rC1", "tC", "old data");
    }),
    null,
  );
  // 3) localhost: scaffolding reply to A (the spanning case) + thread B.
  record(
    Automerge.change(doc, (d) => {
      d.replies["rA2"] = reply("rA2", "tA", "context for the LLM");
      d.threads["tB"] = { target: target("beta"), createdAt: 3 };
      d.replies["rB1"] = reply("rB1", "tB", "localhost feedback");
    }),
    "localhost",
  );

  for (const { bytes, stamp } of changes) {
    const hash = Automerge.decodeChange(bytes).hash;
    const dest = join(commentsDir, normalize(changeKey(POST_PATH, USER, hash)));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
    if (stamp) await writeFile(`${dest}.src`, stamp);
  }

  const result = await loadUnresolvedThreads({ postPath: POST_PATH, commentsDir });
  expect(result.totalCount).toBe(3);
  const byId = new Map(result.unresolved.map((e) => [e.thread.id, e]));

  // Spanning thread: production-born, replies split across origins.
  expect(byId.get("tA")!.origins).toEqual({
    thread: "production",
    replies: { rA1: "production", rA2: "localhost" },
  });
  expect(byId.get("tB")!.origins).toEqual({
    thread: "localhost",
    replies: { rB1: "localhost" },
  });
  expect(byId.get("tC")!.origins).toEqual({
    thread: "unknown",
    replies: { rC1: "unknown" },
  });
});

test("a note-less suggestion survives the zero-reply filter with its payload; a bare plain thread doesn't", async () => {
  if (!isWasmInitialized()) {
    const bytes = await Bun.file(resolveBlogPaths().automergeWasm).arrayBuffer();
    await initializeWasm(new Uint8Array(bytes));
  }
  const commentsDir = await mkdtemp(join(tmpdir(), "suggestion-test-"));

  const suggestion: Suggestion = {
    proposed: "beta",
    authorId: USER,
    authorName: "Fixture",
    authorEmail: "fixture@example.com",
  };
  let doc = Automerge.load<CommentDoc>(Uint8Array.fromBase64(SEED_BYTES_B64));
  doc = Automerge.change(doc, (d) => {
    // Zero replies on both: the suggestion's diff IS its content and must
    // reach the authoring loop; the plain thread is the malformed-blob case
    // the defensive filter exists for.
    d.threads["tS"] = { target: target("alpha"), createdAt: 1, suggestion };
    d.threads["tP"] = { target: target("gamma"), createdAt: 2 };
  });
  const bytes = Automerge.getLastLocalChange(doc)!;
  const hash = Automerge.decodeChange(bytes).hash;
  const dest = join(commentsDir, normalize(changeKey(POST_PATH, USER, hash)));
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, bytes);

  const result = await loadUnresolvedThreads({ postPath: POST_PATH, commentsDir });
  const ids = result.unresolved.map((e) => e.thread.id);
  expect(ids).toEqual(["tS"]);
  expect(result.unresolved[0]!.thread.suggestion).toEqual(suggestion);
});
