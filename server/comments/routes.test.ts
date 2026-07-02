// Unit tests for the comments per-change R2 proxy route layer — the authz /
// visibility matrix the handler enforces (methodology.md → Hardening, same
// anchor the module header cites). Mirrors the visibility table in routes.ts:
//
//   LIST users          → session present AND session is the post's author
//   LIST changes(Y)     → session present AND (session.userId === Y OR author)
//   GET change(Y, *)    → same as LIST changes(Y)
//   PUT change(Y, *)    → session present AND session.userId === Y (not blocked)
//
// Handlers are exercised directly (handleCommentsRequest + a hand-rolled
// CommentsDeps), not through workerRoutes. Sessions are real JWTs; postMeta is
// the real createPostMetaIndex; only the store + rate limiter are fakes. The
// store's resolution surface throws, so a wrong-family call is a hard failure.
// Every 401/403 row also asserts the store was never touched (calls empty).
//
// NOTE: never import ../../happydom.ts here — and happy-dom leaked from
// client/* files would drop the forbidden `cookie` request header (→ spurious
// 401s). The useNativeWebClasses() call below restores Bun's native classes
// for this file's duration (see nativedom.ts for the leak mechanics).

import { test, expect, describe, beforeAll, afterEach } from "bun:test";
import { useNativeWebClasses } from "../../nativedom.ts";
import type { RateLimit } from "@cloudflare/workers-types";
import { handleCommentsRequest, type CommentsDeps } from "./routes.ts";
import { createSessionToken } from "../auth/session.ts";
import { createPostMetaIndex } from "../postMeta.ts";
import { RATE_LIMIT_WINDOW_SECONDS } from "../../shared/problemDetails.ts";
import type {
  ChangeListEntry,
  ChangeOrigin,
  CommentChangeStore,
} from "./store.ts";

// A valid 64-lowercase-hex change hash literal, reused throughout.
const CHANGE = "ab".repeat(32);
const POST = "/posts/x";

// ----- env hygiene (§1.8): snapshot once, restore after every test so a row
// that sets BLOCKED_USERS can't leak into the next. SESSION_SECRET rides in
// the snapshot so token verification keeps working for the whole file.
process.env.SESSION_SECRET = "test-secret-at-least-32-chars-long-xx";
const savedEnv = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

// ----- sessions (real JWTs) -----
let author: string;
let alice: string;
let bob: string;
let unverifiedAuthor: string;
const ALICE_ID = "google:alice-sub";
const BOB_ID = "microsoft:bob-sub";
const AUTHOR_ID = "google:author-sub";

useNativeWebClasses();

beforeAll(async () => {
  author = await createSessionToken({
    userId: AUTHOR_ID, email: "author@example.com", emailVerified: true,
    name: "Author", picture: undefined, provider: "google",
  });
  alice = await createSessionToken({
    userId: ALICE_ID, email: "alice@example.com", emailVerified: true,
    name: "Alice", picture: undefined, provider: "google",
  });
  bob = await createSessionToken({
    userId: BOB_ID, email: "bob@example.com", emailVerified: true,
    name: "Bob", picture: undefined, provider: "microsoft",
  });
  unverifiedAuthor = await createSessionToken({
    userId: "google:impostor", email: "author@example.com", emailVerified: false,
    name: "Impostor", picture: undefined, provider: "google",
  });
});

// ----- postMeta: /posts/x owned by author; /posts/unknown deliberately absent.
const postMeta = createPostMetaIndex({ [POST]: { authorEmail: "author@example.com" } });

// ----- fake store (comments surface real; resolution surface throws) -----
type PutRecord = {
  post: string; user: string; hash: string; bytes: Uint8Array; origin: ChangeOrigin | undefined;
};
function makeStore() {
  const calls: string[] = [];
  const blobs = new Map<string, Uint8Array>();
  const users = new Map<string, string[]>();
  const changeLists = new Map<string, ChangeListEntry[]>();
  const puts: PutRecord[] = [];
  const bkey = (p: string, u: string, h: string) => `${p}|${u}|${h}`;
  const store: CommentChangeStore = {
    async getChange(post, user, hash) { calls.push("getChange"); return blobs.get(bkey(post, user, hash)) ?? null; },
    async putChange(post, user, hash, bytes, origin) {
      calls.push("putChange");
      puts.push({ post, user, hash, bytes, origin });
      blobs.set(bkey(post, user, hash), bytes);
    },
    async listChanges(post, user) { calls.push("listChanges"); return changeLists.get(`${post}|${user}`) ?? []; },
    async listUsers(post) { calls.push("listUsers"); return users.get(post) ?? []; },
    async getResolution() { throw new Error("unexpected store call"); },
    async putResolution() { throw new Error("unexpected store call"); },
    async listResolutions() { throw new Error("unexpected store call"); },
  };
  return { store, calls, blobs, users, changeLists, puts, bkey };
}

function makeLimiter(next = true) {
  const calls: string[] = [];
  const limiter = {
    calls,
    next,
    limit: async ({ key }: { key: string }) => { calls.push(key); return { success: limiter.next }; },
  };
  return limiter;
}

function deps(store: CommentChangeStore, rateLimiter: RateLimit | null): CommentsDeps {
  return { store, postMeta, rateLimiter };
}

// ----- request builder -----
function req(
  method: string,
  query: Record<string, string>,
  opts: { session?: string; body?: BodyInit } = {},
): Request {
  const url = new URL("http://test.local/comments");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (opts.session) headers.cookie = `blog-session=${opts.session}`;
  return new Request(url, { method, headers, body: opts.body });
}

async function problemBody(res: Response): Promise<Record<string, unknown>> {
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  return (await res.json()) as Record<string, unknown>;
}

const okLimiter = () => makeLimiter(true) as unknown as RateLimit;

// =====================================================================
describe("gate order & authn", () => {
  test("1. no cookie → 401 auth/unauthenticated; store untouched", async () => {
    const s = makeStore();
    const res = await handleCommentsRequest(req("GET", { post: POST }), deps(s.store, okLimiter()));
    expect(res.status).toBe(401);
    expect((await problemBody(res)).type as string).toEndWith("auth/unauthenticated");
    expect(s.calls).toEqual([]);
  });

  test("2. garbage cookie → 401; store untouched", async () => {
    const s = makeStore();
    const res = await handleCommentsRequest(req("GET", { post: POST }, { session: "nonsense" }), deps(s.store, okLimiter()));
    expect(res.status).toBe(401);
    expect((await problemBody(res)).type as string).toEndWith("auth/unauthenticated");
    expect(s.calls).toEqual([]);
  });

  test("3. no cookie AND invalid query (missing post) → 401, not 400 (authn precedes parse)", async () => {
    const s = makeStore();
    const res = await handleCommentsRequest(req("GET", {}), deps(s.store, okLimiter()));
    expect(res.status).toBe(401);
    expect((await problemBody(res)).type as string).toEndWith("auth/unauthenticated");
    expect(s.calls).toEqual([]);
  });

  test("4. authenticated + bad query (non-hex change) → 400 request/invalid-parameter", async () => {
    const s = makeStore();
    const res = await handleCommentsRequest(
      req("GET", { post: POST, user: ALICE_ID, change: "XYZ" }, { session: alice }),
      deps(s.store, okLimiter()),
    );
    expect(res.status).toBe(400);
    expect((await problemBody(res)).type as string).toEndWith("request/invalid-parameter");
    expect(s.calls).toEqual([]);
  });
});

// =====================================================================
describe("LIST users (GET ?post)", () => {
  test("5. author → 200 JSON array from listUsers, Cache-Control private no-store", async () => {
    const s = makeStore();
    s.users.set(POST, [ALICE_ID, BOB_ID]);
    const res = await handleCommentsRequest(req("GET", { post: POST }, { session: author }), deps(s.store, okLimiter()));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.json()).toEqual([ALICE_ID, BOB_ID]);
    expect(s.calls).toEqual(["listUsers"]);
  });

  test("6. alice → 403 auth/forbidden; store untouched", async () => {
    const s = makeStore();
    const res = await handleCommentsRequest(req("GET", { post: POST }, { session: alice }), deps(s.store, okLimiter()));
    expect(res.status).toBe(403);
    expect((await problemBody(res)).type as string).toEndWith("auth/forbidden");
    expect(s.calls).toEqual([]);
  });

  test("7. unverifiedAuthor → 403 (verified-email is part of the gate)", async () => {
    const s = makeStore();
    const res = await handleCommentsRequest(req("GET", { post: POST }, { session: unverifiedAuthor }), deps(s.store, okLimiter()));
    expect(res.status).toBe(403);
    expect(s.calls).toEqual([]);
  });

  test("8. author on /posts/unknown (no meta) → 403 (null meta ⇒ nobody is author)", async () => {
    const s = makeStore();
    const res = await handleCommentsRequest(req("GET", { post: "/posts/unknown" }, { session: author }), deps(s.store, okLimiter()));
    expect(res.status).toBe(403);
    expect(s.calls).toEqual([]);
  });

  test("9. PUT ?post (no user) → 405 (method gate, even for author)", async () => {
    const s = makeStore();
    const res = await handleCommentsRequest(req("PUT", { post: POST }, { session: author }), deps(s.store, okLimiter()));
    expect(res.status).toBe(405);
    expect((await problemBody(res)).type).toBe("about:blank");
    expect(s.calls).toEqual([]);
  });
});

// =====================================================================
describe("LIST changes (GET ?post&user)", () => {
  test("10. alice listing her own → 200", async () => {
    const s = makeStore();
    const res = await handleCommentsRequest(req("GET", { post: POST, user: ALICE_ID }, { session: alice }), deps(s.store, okLimiter()));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(s.calls).toEqual(["listChanges"]);
  });

  test("11. author listing alice's → 200 (author read power)", async () => {
    const s = makeStore();
    const res = await handleCommentsRequest(req("GET", { post: POST, user: ALICE_ID }, { session: author }), deps(s.store, okLimiter()));
    expect(res.status).toBe(200);
    expect(s.calls).toEqual(["listChanges"]);
  });

  test("12. bob listing alice's → 403; store untouched", async () => {
    const s = makeStore();
    const res = await handleCommentsRequest(req("GET", { post: POST, user: ALICE_ID }, { session: bob }), deps(s.store, okLimiter()));
    expect(res.status).toBe(403);
    expect((await problemBody(res)).type as string).toEndWith("auth/forbidden");
    expect(s.calls).toEqual([]);
  });

  test("13. POST → 405", async () => {
    const s = makeStore();
    const res = await handleCommentsRequest(req("POST", { post: POST, user: ALICE_ID }, { session: alice }), deps(s.store, okLimiter()));
    expect(res.status).toBe(405);
    expect((await problemBody(res)).type).toBe("about:blank");
    expect(s.calls).toEqual([]);
  });
});

// =====================================================================
describe("GET change (?post&user&change)", () => {
  test("14. alice her own, present → 200 octet-stream, immutable cache, bytes round-trip", async () => {
    const s = makeStore();
    const bytes = new Uint8Array([10, 20, 30]);
    s.blobs.set(s.bkey(POST, ALICE_ID, CHANGE), bytes);
    const res = await handleCommentsRequest(req("GET", { post: POST, user: ALICE_ID, change: CHANGE }, { session: alice }), deps(s.store, okLimiter()));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  test("15. author reading alice's → 200", async () => {
    const s = makeStore();
    s.blobs.set(s.bkey(POST, ALICE_ID, CHANGE), new Uint8Array([1]));
    const res = await handleCommentsRequest(req("GET", { post: POST, user: ALICE_ID, change: CHANGE }, { session: author }), deps(s.store, okLimiter()));
    expect(res.status).toBe(200);
  });

  test("16. bob reading alice's → 403; store untouched (gate precedes getChange)", async () => {
    const s = makeStore();
    s.blobs.set(s.bkey(POST, ALICE_ID, CHANGE), new Uint8Array([1]));
    const res = await handleCommentsRequest(req("GET", { post: POST, user: ALICE_ID, change: CHANGE }, { session: bob }), deps(s.store, okLimiter()));
    expect(res.status).toBe(403);
    expect(s.calls).toEqual([]);
  });

  test("17. alice her own, absent → 404 (about:blank); getChange WAS called (404 is post-authz)", async () => {
    const s = makeStore();
    const res = await handleCommentsRequest(req("GET", { post: POST, user: ALICE_ID, change: CHANGE }, { session: alice }), deps(s.store, okLimiter()));
    expect(res.status).toBe(404);
    expect((await problemBody(res)).type).toBe("about:blank");
    expect(s.calls).toEqual(["getChange"]);
  });

  test("18. DELETE with all three params → 405", async () => {
    const s = makeStore();
    const res = await handleCommentsRequest(req("DELETE", { post: POST, user: ALICE_ID, change: CHANGE }, { session: alice }), deps(s.store, okLimiter()));
    expect(res.status).toBe(405);
    expect(s.calls).toEqual([]);
  });
});

// =====================================================================
describe("PUT change", () => {
  test("19. alice → own folder, 8-byte body → 200; putChange gets exact (post,user,hash,bytes,undefined)", async () => {
    const s = makeStore();
    const body = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const res = await handleCommentsRequest(req("PUT", { post: POST, user: ALICE_ID, change: CHANGE }, { session: alice, body }), deps(s.store, okLimiter()));
    expect(res.status).toBe(200);
    expect(s.puts).toHaveLength(1);
    const p = s.puts[0]!;
    expect(p.post).toBe(POST);
    expect(p.user).toBe(ALICE_ID);
    expect(p.hash).toBe(CHANGE);
    expect(new Uint8Array(p.bytes)).toEqual(body);
    expect(p.origin).toBeUndefined();
  });

  test("20. origin=production in query → putChange receives \"production\"", async () => {
    const s = makeStore();
    const body = new Uint8Array(8);
    await handleCommentsRequest(req("PUT", { post: POST, user: ALICE_ID, change: CHANGE, origin: "production" }, { session: alice, body }), deps(s.store, okLimiter()));
    expect(s.puts[0]!.origin).toBe("production");
  });

  test("21. author → alice's folder → 403 (author has no PUT power); store untouched", async () => {
    const s = makeStore();
    const body = new Uint8Array(8);
    const res = await handleCommentsRequest(req("PUT", { post: POST, user: ALICE_ID, change: CHANGE }, { session: author, body }), deps(s.store, okLimiter()));
    expect(res.status).toBe(403);
    expect((await problemBody(res)).type as string).toEndWith("auth/forbidden");
    expect(s.calls).toEqual([]);
  });

  test("22. blocked user → 200, putChange NOT called, rate limiter NOT called (silent discard)", async () => {
    process.env.BLOCKED_USERS = ALICE_ID;
    const s = makeStore();
    const limiter = makeLimiter(true);
    const body = new Uint8Array(8);
    const res = await handleCommentsRequest(req("PUT", { post: POST, user: ALICE_ID, change: CHANGE }, { session: alice, body }), deps(s.store, limiter as unknown as RateLimit));
    expect(res.status).toBe(200);
    expect(s.calls).toEqual([]);
    expect(limiter.calls).toEqual([]);
  });

  test("23. rate limit, non-author (next=false) → 429 with retryAfter; limiter keyed on userId; putChange NOT called", async () => {
    const s = makeStore();
    const limiter = makeLimiter(false);
    const body = new Uint8Array(8);
    const res = await handleCommentsRequest(req("PUT", { post: POST, user: ALICE_ID, change: CHANGE }, { session: alice, body }), deps(s.store, limiter as unknown as RateLimit));
    expect(res.status).toBe(429);
    const b = await problemBody(res);
    expect(b.type as string).toEndWith("rate-limit/exceeded");
    expect(b.retryAfter).toBe(RATE_LIMIT_WINDOW_SECONDS);
    expect(limiter.calls).toEqual([ALICE_ID]);
    expect(s.calls).toEqual([]);
  });

  test("24. rate limit, author on own folder → limiter NOT called (author exemption)", async () => {
    const s = makeStore();
    const limiter = makeLimiter(false); // would 429 if consulted
    const body = new Uint8Array(8);
    const res = await handleCommentsRequest(req("PUT", { post: POST, user: AUTHOR_ID, change: CHANGE }, { session: author, body }), deps(s.store, limiter as unknown as RateLimit));
    expect(res.status).toBe(200);
    expect(limiter.calls).toEqual([]);
    expect(s.puts).toHaveLength(1);
  });

  test("25. rateLimiter null (dev) → PUT succeeds, no throw", async () => {
    const s = makeStore();
    const body = new Uint8Array(8);
    const res = await handleCommentsRequest(req("PUT", { post: POST, user: ALICE_ID, change: CHANGE }, { session: alice, body }), deps(s.store, null));
    expect(res.status).toBe(200);
    expect(s.puts).toHaveLength(1);
  });

  test("26. oversize 8193 → 413 change-too-large {maxBytes:8192, actualBytes:8193}; boundary 8192 → 200", async () => {
    const over = await handleCommentsRequest(
      req("PUT", { post: POST, user: ALICE_ID, change: CHANGE }, { session: alice, body: new Uint8Array(8193) }),
      deps(makeStore().store, okLimiter()),
    );
    expect(over.status).toBe(413);
    const b = await problemBody(over);
    expect(b.type as string).toEndWith("comments/change-too-large");
    expect(b.maxBytes).toBe(8192);
    expect(b.actualBytes).toBe(8193);

    const s = makeStore();
    const at = await handleCommentsRequest(
      req("PUT", { post: POST, user: ALICE_ID, change: CHANGE }, { session: alice, body: new Uint8Array(8192) }),
      deps(s.store, okLimiter()),
    );
    expect(at.status).toBe(200);
    expect(s.puts).toHaveLength(1);
  });

  test("27. empty body → 400 request/empty-body", async () => {
    const s = makeStore();
    const res = await handleCommentsRequest(req("PUT", { post: POST, user: ALICE_ID, change: CHANGE }, { session: alice }), deps(s.store, okLimiter()));
    expect(res.status).toBe(400);
    expect((await problemBody(res)).type as string).toEndWith("request/empty-body");
    expect(s.puts).toEqual([]);
  });
});
