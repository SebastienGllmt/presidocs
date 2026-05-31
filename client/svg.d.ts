// Bun's `with { type: "text" }` import attribute returns a file's contents as
// a string. TypeScript doesn't know about that resolution and reports SVG
// imports as TS2307 ("Cannot find module …"); declaring `*.svg` as a string-
// defaulted module silences the diagnostic without needing per-import shims.
// Only string-typed SVG imports exist in this repo (every one carries the
// `with { type: "text" }` attribute — see client/byline.ts) so the wildcard
// matches reality.
declare module "*.svg" {
  const content: string;
  export default content;
}
