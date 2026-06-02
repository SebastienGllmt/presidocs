// Unit tests for the HTTP request query schemas and the zod→problem adapter.
// These are pure (no session/store harness): they exercise the shape rules
// the route handlers now delegate to, plus the uniform 400 rendering.

import { test, expect } from "bun:test";
import {
  CommentsQuery,
  ResolutionsQuery,
  PostVersionQuery,
  zodBadRequest,
} from "./requestSchemas.ts";

const VALID_USER = "google:1234567890";
const VALID_HASH = "a".repeat(64);

test("CommentsQuery: post-only parses (user/change undefined)", () => {
  const r = CommentsQuery.safeParse({ post: "/posts/foo" });
  expect(r.success).toBe(true);
  if (r.success) {
    expect(r.data).toEqual({ post: "/posts/foo", user: undefined, change: undefined });
  }
});

test("CommentsQuery: full triple parses", () => {
  const r = CommentsQuery.safeParse({
    post: "/posts/foo",
    user: VALID_USER,
    change: VALID_HASH,
  });
  expect(r.success).toBe(true);
});

test("CommentsQuery: missing post is rejected", () => {
  expect(CommentsQuery.safeParse({}).success).toBe(false);
  expect(CommentsQuery.safeParse({ post: "" }).success).toBe(false);
});

test("CommentsQuery: malformed user prefix is rejected", () => {
  expect(CommentsQuery.safeParse({ post: "/p", user: "github:1" }).success).toBe(false);
  expect(CommentsQuery.safeParse({ post: "/p", user: "google:" }).success).toBe(false);
});

test("CommentsQuery: change must be 64 lowercase hex", () => {
  expect(CommentsQuery.safeParse({ post: "/p", user: VALID_USER, change: "xyz" }).success).toBe(false);
  expect(CommentsQuery.safeParse({ post: "/p", user: VALID_USER, change: "A".repeat(64) }).success).toBe(false);
  expect(CommentsQuery.safeParse({ post: "/p", user: VALID_USER, change: "a".repeat(63) }).success).toBe(false);
});

test("ResolutionsQuery / PostVersionQuery: post is required", () => {
  expect(ResolutionsQuery.safeParse({ post: "/p" }).success).toBe(true);
  expect(ResolutionsQuery.safeParse({ post: "/p", thread: "t1" }).success).toBe(true);
  expect(ResolutionsQuery.safeParse({}).success).toBe(false);
  expect(PostVersionQuery.safeParse({ post: "/p" }).success).toBe(true);
  expect(PostVersionQuery.safeParse({}).success).toBe(false);
});

test("zodBadRequest renders a uniform RFC 9457 problem+json 400", async () => {
  const r = CommentsQuery.safeParse({});
  expect(r.success).toBe(false);
  if (r.success) return;
  const res = zodBadRequest(r.error);
  expect(res.status).toBe(400);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.status).toBe(400);
  expect(String(body.type)).toMatch(/\/request\/invalid-parameter$/);
  expect(body.param).toBe("post");
  expect(Array.isArray(body.issues)).toBe(true);
});
