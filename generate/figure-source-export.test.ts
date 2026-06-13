import { describe, expect, test } from "bun:test";
import { collectFigureSrc, spdxHeader } from "./figure-source-export.ts";

describe("collectFigureSrc", () => {
  test("collects validated, de-duped, sorted data-figure-src values", () => {
    const html = `<article>
      <figure id="a" data-figure-src="zswapCost"></figure>
      <figure id="b" data-figure-src="deltasVanish"></figure>
      <figure id="c" data-figure-src="deltasVanish"></figure>
      <figure id="static"></figure>
    </article>`;
    // de-duped (deltasVanish once) and sorted; the attribute-less static figure ignored.
    expect(collectFigureSrc(html)).toEqual(["deltasVanish", "zswapCost"]);
  });

  test("drops unsafe tokens (traversal / separators), keeps the safe one", () => {
    const html =
      `<figure data-figure-src="../secret"></figure>` +
      `<figure data-figure-src="a/b"></figure>` +
      `<figure data-figure-src="ok"></figure>`;
    expect(collectFigureSrc(html)).toEqual(["ok"]);
  });

  test("empty when no figure carries the attribute", () => {
    expect(collectFigureSrc(`<figure id="x"></figure><p>text</p>`)).toEqual([]);
  });
});

describe("spdxHeader", () => {
  const lic = { id: "MIT", url: "https://opensource.org/license/mit" };

  test("a // line for .ts and a /* */ line for .css", () => {
    expect(spdxHeader(lic, "ts")).toBe("// SPDX-License-Identifier: MIT\n");
    expect(spdxHeader(lic, "css")).toBe("/* SPDX-License-Identifier: MIT */\n");
  });

  test("empty (no header) when no code license is set — never a guessed default", () => {
    expect(spdxHeader(null, "ts")).toBe("");
    expect(spdxHeader(null, "css")).toBe("");
  });
});
