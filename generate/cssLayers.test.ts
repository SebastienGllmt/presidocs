import { test, expect } from "bun:test";
import { join } from "node:path";
import {
  CSS_LAYER_ORDER_STATEMENT,
  checkHeadLayerOrder,
  collectLayerNames,
  foreignLayerNames,
  injectLayerOrderStyle,
  layerOrderStatements,
} from "./cssLayers.ts";

const ROOT = join(import.meta.dir, "..");
const clientCss = (f: string): string => join(ROOT, "client", f);

// Every stylesheet the engine ships. `landing.css` uses no layers (separate
// cascade context for the landing/legal pages) and is included to assert it
// stays that way.
const ENGINE_CSS = [
  "base.css",
  "narrator.css",
  "comments.css",
  "landing.css",
  "shikwasa-vendor.css",
].map(clientCss);

test("base.css declares exactly the canonical layer-order statement", async () => {
  const css = await Bun.file(clientCss("base.css")).text();
  const stmts = layerOrderStatements(css).map((s) => s.replace(/\s+/g, " ").trim());
  expect(stmts).toContain(CSS_LAYER_ORDER_STATEMENT);
});

test("no engine stylesheet introduces a layer outside the registry", async () => {
  for (const path of ENGINE_CSS) {
    const css = await Bun.file(path).text();
    // Report the path alongside the names so a failure says which file.
    expect({ path, foreign: foreignLayerNames(css) }).toEqual({ path, foreign: [] });
  }
});

test("the comment-stripped name scan ignores @layer mentions in prose", () => {
  const css = `/* talks about @layer ghost { } in a comment */ @layer real { a { color: red } }`;
  expect(collectLayerNames(css)).toEqual(["real"]);
});

test("checkHeadLayerOrder flags a missing / mis-ordered statement", () => {
  expect(checkHeadLayerOrder("<head><title>x</title></head>")).toEqual([
    expect.stringContaining("no inline <style>"),
  ]);
  const linkFirst =
    '<head><link rel="stylesheet" href="a.css">' +
    `<style>${CSS_LAYER_ORDER_STATEMENT}</style></head>`;
  expect(checkHeadLayerOrder(linkFirst)).toEqual([
    expect.stringContaining('<link rel="stylesheet"> appears before'),
  ]);
});

test("checkHeadLayerOrder flags a <script type=module> before the @layer style", () => {
  const html =
    '<head><script type="module" src="x.ts"></script>' +
    `<style>${CSS_LAYER_ORDER_STATEMENT}</style></head>`;
  expect(checkHeadLayerOrder(html)).toEqual([
    expect.stringContaining('<script type="module"> appears before'),
  ]);
});

test("checkHeadLayerOrder flags a statement that does not match the canonical order", () => {
  const html = "<head><style>@layer post, engine-tokens;</style></head>";
  expect(checkHeadLayerOrder(html)).toEqual([
    expect.stringContaining("does not match canonical"),
  ]);
});

test("checkHeadLayerOrder is not fooled by <link>/<script> strings in comments or script text", () => {
  // A real parser does not treat markup inside an HTML comment or a <script>
  // body as elements — the old .search(/<link …>/) regex would false-positive.
  const html =
    "<head>" +
    '<!-- <link rel="stylesheet" href="ghost.css"> -->' +
    `<style>${CSS_LAYER_ORDER_STATEMENT}</style>` +
    `<script>const s = '<script type="module">';</script>` +
    "</head>";
  expect(checkHeadLayerOrder(html)).toEqual([]);
});

test("injectLayerOrderStyle pins the order first for a layer-system page", () => {
  const src =
    '<html><head><meta charset="utf-8">' +
    '<link rel="stylesheet" href="../engine/client/base.css">' +
    '<script type="module" src="x.ts"></script></head><body></body></html>';
  const out = injectLayerOrderStyle(src);
  expect(checkHeadLayerOrder(out)).toEqual([]); // present, and before link + module
});

test("injectLayerOrderStyle is idempotent and skips non-layer pages", () => {
  const layer = '<head><link rel="stylesheet" href="../engine/client/base.css"></head>';
  const once = injectLayerOrderStyle(layer);
  expect(injectLayerOrderStyle(once)).toBe(once); // running twice is a no-op
  expect((once.match(/engine-layer-order/g) ?? []).length).toBe(1);

  const landing = '<head><link rel="stylesheet" href="landing.css"></head>';
  expect(injectLayerOrderStyle(landing)).toBe(landing); // no base.css → untouched
});
