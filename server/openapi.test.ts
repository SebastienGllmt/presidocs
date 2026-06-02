// Guards the derived OpenAPI document: a new endpoint without a registration,
// or a generator/version regression, is caught here.

import { test, expect } from "bun:test";
import { buildOpenApiDocument } from "./openapi.ts";

test("document is OpenAPI 3.1.0 and registers every gated content endpoint", () => {
  const doc = buildOpenApiDocument() as unknown as {
    openapi: string;
    paths: Record<string, Record<string, { parameters?: { name: string }[] }>>;
    components: { schemas: Record<string, unknown> };
  };

  expect(doc.openapi).toBe("3.1.0");
  expect(Object.keys(doc.paths).sort()).toEqual([
    "/comments",
    "/post-version",
    "/resolutions",
  ]);

  expect(doc.paths["/comments"]!.get).toBeDefined();
  expect(doc.paths["/comments"]!.put).toBeDefined();
  expect(doc.paths["/resolutions"]!.get).toBeDefined();
  expect(doc.paths["/resolutions"]!.put).toBeDefined();
  expect(doc.paths["/post-version"]!.get).toBeDefined();
});

test("query parameters are derived from the zod schemas", () => {
  const doc = buildOpenApiDocument() as unknown as {
    paths: Record<string, Record<string, { parameters?: { name: string }[] }>>;
  };
  const names = (doc.paths["/comments"]!.get!.parameters ?? [])
    .map((p) => p.name)
    .sort();
  expect(names).toEqual(["change", "post", "user"]);
});

test("response component schemas are present", () => {
  const doc = buildOpenApiDocument() as unknown as {
    components: { schemas: Record<string, unknown> };
  };
  for (const name of [
    "CommentUsersResponse",
    "CommentChangesResponse",
    "ResolutionsListResponse",
    "PostVersionResponse",
    "ProblemDetails",
  ]) {
    expect(doc.components.schemas[name]).toBeDefined();
  }
});
