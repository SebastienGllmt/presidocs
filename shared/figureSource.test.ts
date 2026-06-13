import { describe, expect, test } from "bun:test";
import { figureSourceHref, isValidFigureSrc } from "./figureSource.ts";

describe("isValidFigureSrc", () => {
  test("accepts bare module basenames (camelCase, digits, _ and - inside)", () => {
    for (const s of ["hashAvalanche", "offerVolume", "deltasVanish", "fileWrap", "a", "a1", "a-b", "a_b", "Chart2"]) {
      expect(isValidFigureSrc(s)).toBe(true);
    }
  });

  test("rejects empties, separators, dots, traversal, and a leading non-alnum", () => {
    // A `.` is disallowed entirely, which also forecloses `.ts`/`..` traversal;
    // `/` and `\\` can't appear; a leading `-`/`_` is rejected.
    for (const s of ["", "../x", "a/b", "a\\b", "a.ts", ".hidden", "a..b", "-lead", "_lead", "a b", "/abs", "a.b"]) {
      expect(isValidFigureSrc(s)).toBe(false);
    }
  });
});

describe("figureSourceHref", () => {
  test("relative base (slug) → relative path one level below the post's .md", () => {
    expect(figureSourceHref("offer-files", "deltasVanish")).toBe("offer-files/figures/deltasVanish.ts");
  });

  test("absolute base (post URL) → self-contained absolute link", () => {
    expect(figureSourceHref("https://blog.example.com/posts/offer-files", "intentCompare")).toBe(
      "https://blog.example.com/posts/offer-files/figures/intentCompare.ts",
    );
  });

  test("a private token slug is carried verbatim, so the link inherits the capability", () => {
    expect(figureSourceHref("https://blog.example.com/posts/offer-files--Xk3n8fQ2pLwz9", "fileWrap")).toBe(
      "https://blog.example.com/posts/offer-files--Xk3n8fQ2pLwz9/figures/fileWrap.ts",
    );
  });
});
