import { describe, expect, test } from "bun:test";
import { figureSubtree, figureCacheKey } from "./figureCacheKey.ts";

describe("figureSubtree", () => {
  test("extracts the figure with the matching id", () => {
    const html = `<article><figure id="a"><svg>A</svg></figure><figure id="b"><svg>B</svg></figure></article>`;
    expect(figureSubtree(html, "a")).toContain(">A<");
    expect(figureSubtree(html, "a")).not.toContain(">B<");
    expect(figureSubtree(html, "b")).toContain(">B<");
  });

  test("does not truncate at a NESTED figure's close tag (regex bug)", () => {
    // The old regex stopped at the first </figure>, dropping the tail of the
    // outer figure. A real parser returns the whole outer subtree.
    const html = `<figure id="outer"><figcaption>cap</figcaption><figure id="inner">in</figure><svg>tail</svg></figure>`;
    const sub = figureSubtree(html, "outer");
    expect(sub).toContain("in");
    expect(sub).toContain("tail"); // the part the regex lost
    expect(sub).toContain("cap");
  });

  test("handles whitespace inside the closing tag", () => {
    // `</figure >` did not match the old literal `</figure>`.
    const html = `<figure id="a"><svg>A</svg></figure >`;
    expect(figureSubtree(html, "a")).toContain(">A<");
  });

  test("is order-agnostic about attributes around id", () => {
    const html = `<figure class="x" data-y="1" id="a" role="img"><svg>A</svg></figure>`;
    expect(figureSubtree(html, "a")).toContain(">A<");
  });

  test("falls back to the whole doc on no match (safe over-invalidation)", () => {
    const html = `<article>no figure here</article>`;
    expect(figureSubtree(html, "missing")).toBe(html);
  });

  test("is stable: same input → same serialization", () => {
    const html = `<figure id="a"><svg viewBox="0 0 1 1">A</svg></figure>`;
    expect(figureSubtree(html, "a")).toBe(figureSubtree(html, "a"));
  });
});

describe("figureCacheKey", () => {
  test("changes when the figure markup changes, stable otherwise", () => {
    const env = "env-hash";
    const h1 = `<figure id="a"><svg>A</svg></figure>`;
    const h2 = `<figure id="a"><svg>B</svg></figure>`;
    expect(figureCacheKey(env, "a", h1)).toBe(figureCacheKey(env, "a", h1));
    expect(figureCacheKey(env, "a", h1)).not.toBe(figureCacheKey(env, "a", h2));
  });
});
