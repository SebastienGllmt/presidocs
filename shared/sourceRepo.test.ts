import { describe, expect, test } from "bun:test";
import { resolveSourceRepo, sourceUrlForPostPath } from "./sourceRepo.ts";

describe("resolveSourceRepo", () => {
  test("unset SOURCE_REPO_URL → null (opt-in)", () => {
    expect(resolveSourceRepo({})).toBeNull();
    expect(resolveSourceRepo({ SOURCE_REPO_URL: "   " })).toBeNull();
  });

  test("set → base includes /blob/<branch>, default branch main, trailing slash trimmed", () => {
    expect(resolveSourceRepo({ SOURCE_REPO_URL: "https://github.com/you/blog" })).toEqual({
      base: "https://github.com/you/blog/blob/main",
    });
    expect(resolveSourceRepo({ SOURCE_REPO_URL: "https://github.com/you/blog/" })).toEqual({
      base: "https://github.com/you/blog/blob/main",
    });
  });

  test("SOURCE_REPO_BRANCH overrides the default", () => {
    expect(
      resolveSourceRepo({ SOURCE_REPO_URL: "https://github.com/you/blog", SOURCE_REPO_BRANCH: "trunk" }),
    ).toEqual({ base: "https://github.com/you/blog/blob/trunk" });
  });

  test("private blog → null even when SOURCE_REPO_URL is set (no public link on a gated post)", () => {
    expect(
      resolveSourceRepo({ SOURCE_REPO_URL: "https://github.com/you/blog", BLOG_PRIVATE: "1" }),
    ).toBeNull();
  });
});

describe("sourceUrlForPostPath", () => {
  const repo = { base: "https://github.com/you/blog/blob/main" };

  test("post site path maps to the repo file path + .html", () => {
    expect(sourceUrlForPostPath(repo, "/posts/offer-files")).toBe(
      "https://github.com/you/blog/blob/main/posts/offer-files.html",
    );
  });

  test("a private token slug is carried verbatim (though private blogs resolve to null upstream)", () => {
    expect(sourceUrlForPostPath(repo, "/posts/secret--Xk3n8fQ2pLwz9")).toBe(
      "https://github.com/you/blog/blob/main/posts/secret--Xk3n8fQ2pLwz9.html",
    );
  });
});
