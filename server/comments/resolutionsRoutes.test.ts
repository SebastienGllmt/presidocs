// Unit tests for the per-post resolution route layer. The point of this file
// is the DIFFERENT visibility model from /comments (methodology.md → Hardening;
// resolutionsRoutes.ts:8-15):
//
//   LIST + GET → ANY logged-in user (threadIds are opaque; meaningless without
//                the matching private CRDT thread)
//   PUT        → post author only (verified-email email match)
//
// Handlers are exercised directly (handleResolutionsRequest + a hand-rolled
// ResolutionsDeps). Sessions are real JWTs; postMeta is the real
// createPostMetaIndex; only the store is a fake whose CHANGE surface throws, so
// a wrong-family call is a hard failure. Every 401/403 row also asserts the
// store was never touched.
//
// NOTE: never import ../../happydom.ts here — and happy-dom leaked from
// client/* files would drop the forbidden `cookie` request header (→ spurious
// 401s). The useNativeWebClasses() call below restores Bun's native classes
// for this file's duration (see nativedom.ts for the leak mechanics).

import { test, expect, describe, beforeAll, afterEach } from "bun:test";
import { useNativeWebClasses } from "../../nativedom.ts";
import { handleResolutionsRequest, type ResolutionsDeps } from "./resolutionsRoutes.ts";
import { createSessionToken } from "../auth/session.ts";
import { createPostMetaIndex } from "../postMeta.ts";
import type { CommentChangeStore, ResolutionListEntry } from "./store.ts";

const POST = "/posts/x";
const THREAD = "t1";

process.env.SESSION_SECRET = "test-secret-at-least-32-chars-long-xx";
const savedEnv = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

let author: string;
let alice: string;
let bob: string;
let unverifiedAuthor: string;

useNativeWebClasses();

beforeAll(async () => {
  author = await createSessionToken({
    userId: "google:author-sub", email: "author@example.com", emailVerified: true,
    name: "Author", picture: undefined, provider: "google",
  });
  alice = await createSessionToken({
    userId: "google:alice-sub", email: "alice@example.com", emailVerified: true,
    name: "Alice", picture: undefined, provider: "google",
  });
  bob = await createSessionToken({
    userId: "microsoft:bob-sub", email: "bob@example.com", emailVerified: true,
    name: "Bob", picture: undefined, provider: "microsoft",
  });
  unverifiedAuthor = await createSessionToken({
    userId: "google:impostor", email: "author@example.com", emailVerified: false,
    name: "Impostor", picture: undefined, provider: "google",
  });
});

const postMeta = createPostMetaIndex({ [POST]: { authorEmail: "author@example.com" } });

// fake store: resolution surface real; change surface throws.
type PutRecord = { post: string; thread: string; bytes: Uint8Array };
function makeStore() {
  const calls: string[] = [];
  const blobs = new Map<string, Uint8Array>();
  const lists = new Map<string, ResolutionListEntry[]>();
  const puts: PutRecord[] = [];
  const bkey = (p: string, t: string) => `${p} ${t}`;
  const store: CommentChangeStore = {
    async getChange() { throw new Error("unexpected store call"); },
    async putChange() { throw new Error("unexpected store call"); },
    async listChanges() { throw new Error("unexpected store call"); },
    async listUsers() { throw new Error("unexpected store call"); },
    async getResolution(post, thread) { calls.push("getResolution"); return blobs.get(bkey(post, thread)) ?? null; },
    async putResolution(post, thread, bytes) { calls.push("putResolution"); puts.push({ post, thread, bytes }); blobs.set(bkey(post, thread), bytes); },
    async listResolutions(post) { calls.push("listResolutions"); return lists.get(post) ?? []; },
  };
  return { store, calls, blobs, lists, puts, bkey };
}

function deps(store: CommentChangeStore): ResolutionsDeps {
  return { store, postMeta };
}

function req(
  method: string,
  query: Record<string, string>,
  opts: { session?: string; body?: BodyInit } = {},
): Request {
  const url = new URL("http://test.local/resolutions");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (opts.session) headers.cookie = `blog-session=${opts.session}`;
  return new Request(url, { method, headers, body: opts.body });
}

async function problemBody(res: Response): Promise<Record<string, unknown>> {
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  return (await res.json()) as Record<string, unknown>;
}

// =====================================================================
describe("authn / gate order", () => {
  test("1. no cookie → 401; store untouched", async () => {
    const s = makeStore();
    const res = await handleResolutionsRequest(req("GET", { post: POST }), deps(s.store));
    expect(res.status).toBe(401);
    expect((await problemBody(res)).type as string).toEndWith("auth/unauthenticated");
    expect(s.calls).toEqual([]);
  });

  test("2. no cookie + invalid query → 401 (auth precedes parse)", async () => {
    const s = makeStore();
    const res = await handleResolutionsRequest(req("GET", {}), deps(s.store));
    expect(res.status).toBe(401);
    expect(s.calls).toEqual([]);
  });
});

describe("LIST / GET — any logged-in user", () => {
  test("3. LIST: bob (arbitrary non-author) → 200 + private no-store (the /comments difference)", async () => {
    const s = makeStore();
    s.lists.set(POST, [{ threadId: THREAD, size: 3, uploaded: new Date() }]);
    const res = await handleResolutionsRequest(req("GET", { post: POST }, { session: bob }), deps(s.store));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(s.calls).toEqual(["listResolutions"]);
  });

  test("4. LIST with PUT method (no thread) → 405", async () => {
    const s = makeStore();
    const res = await handleResolutionsRequest(req("PUT", { post: POST }, { session: author }), deps(s.store));
    expect(res.status).toBe(405);
    expect((await problemBody(res)).type).toBe("about:blank");
    expect(s.calls).toEqual([]);
  });

  test("5. GET one: alice → 200 application/json, max-age=10, bytes round-trip", async () => {
    const s = makeStore();
    const bytes = new Uint8Array([9, 8, 7]);
    s.blobs.set(s.bkey(POST, THREAD), bytes);
    const res = await handleResolutionsRequest(req("GET", { post: POST, thread: THREAD }, { session: alice }), deps(s.store));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=10");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  test("6. GET absent → 404", async () => {
    const s = makeStore();
    const res = await handleResolutionsRequest(req("GET", { post: POST, thread: THREAD }, { session: alice }), deps(s.store));
    expect(res.status).toBe(404);
    expect((await problemBody(res)).type).toBe("about:blank");
    expect(s.calls).toEqual(["getResolution"]);
  });
});

describe("PUT — author only", () => {
  test("7. author → 200; putResolution(post, thread, bytes) recorded", async () => {
    const s = makeStore();
    const body = new Uint8Array([1, 2, 3, 4]);
    const res = await handleResolutionsRequest(req("PUT", { post: POST, thread: THREAD }, { session: author, body }), deps(s.store));
    expect(res.status).toBe(200);
    expect(s.puts).toHaveLength(1);
    expect(s.puts[0]!.post).toBe(POST);
    expect(s.puts[0]!.thread).toBe(THREAD);
    expect(new Uint8Array(s.puts[0]!.bytes)).toEqual(body);
  });

  test("8. alice → 403; store untouched", async () => {
    const s = makeStore();
    const res = await handleResolutionsRequest(req("PUT", { post: POST, thread: THREAD }, { session: alice, body: new Uint8Array(4) }), deps(s.store));
    expect(res.status).toBe(403);
    expect((await problemBody(res)).type as string).toEndWith("auth/forbidden");
    expect(s.calls).toEqual([]);
  });

  test("9. unverifiedAuthor → 403", async () => {
    const s = makeStore();
    const res = await handleResolutionsRequest(req("PUT", { post: POST, thread: THREAD }, { session: unverifiedAuthor, body: new Uint8Array(4) }), deps(s.store));
    expect(res.status).toBe(403);
    expect(s.calls).toEqual([]);
  });

  test("10. author on /posts/unknown → 403 (null meta)", async () => {
    const s = makeStore();
    const res = await handleResolutionsRequest(req("PUT", { post: "/posts/unknown", thread: THREAD }, { session: author, body: new Uint8Array(4) }), deps(s.store));
    expect(res.status).toBe(403);
    expect(s.calls).toEqual([]);
  });

  test("11. oversize 2049 → 413 resolution-too-large {maxBytes:2048, actualBytes:2049}; boundary 2048 → 200", async () => {
    const over = await handleResolutionsRequest(
      req("PUT", { post: POST, thread: THREAD }, { session: author, body: new Uint8Array(2049) }),
      deps(makeStore().store),
    );
    expect(over.status).toBe(413);
    const b = await problemBody(over);
    expect(b.type as string).toEndWith("resolutions/resolution-too-large");
    expect(b.maxBytes).toBe(2048);
    expect(b.actualBytes).toBe(2049);

    const s = makeStore();
    const at = await handleResolutionsRequest(
      req("PUT", { post: POST, thread: THREAD }, { session: author, body: new Uint8Array(2048) }),
      deps(s.store),
    );
    expect(at.status).toBe(200);
    expect(s.puts).toHaveLength(1);
  });

  test("12. empty PUT → 400 request/empty-body", async () => {
    const s = makeStore();
    const res = await handleResolutionsRequest(req("PUT", { post: POST, thread: THREAD }, { session: author }), deps(s.store));
    expect(res.status).toBe(400);
    expect((await problemBody(res)).type as string).toEndWith("request/empty-body");
    expect(s.puts).toEqual([]);
  });

  test("13. DELETE ?post&thread → 405", async () => {
    const s = makeStore();
    const res = await handleResolutionsRequest(req("DELETE", { post: POST, thread: THREAD }, { session: author }), deps(s.store));
    expect(res.status).toBe(405);
    expect((await problemBody(res)).type).toBe("about:blank");
    expect(s.calls).toEqual([]);
  });
});
