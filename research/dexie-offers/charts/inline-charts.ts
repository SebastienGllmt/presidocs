/**
 * Inline the generated SVG charts into posts/offer-files-data.html so the post
 * stays a single self-contained file (per the project's one-file-per-post rule).
 * Idempotent: replaces content between `<!--CHART:id-->` and `<!--/CHART:id-->`
 * markers, so re-running after `make-charts.ts` refreshes every figure in place.
 *
 *   bun research/dexie-offers/charts/make-charts.ts && bun research/dexie-offers/charts/inline-charts.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const POST = join(ROOT, "posts", "offer-files-data.html");
const CHARTS = join(ROOT, "generated", "charts");

let html = readFileSync(POST, "utf8");
let count = 0;
html = html.replace(
  /<!--CHART:([a-z0-9-]+)-->[\s\S]*?<!--\/CHART:\1-->/g,
  (_m, id) => {
    const svg = readFileSync(join(CHARTS, `${id}.svg`), "utf8").trim();
    count++;
    return `<!--CHART:${id}-->\n${svg}\n<!--/CHART:${id}-->`;
  },
);
writeFileSync(POST, html);
console.log(`inlined ${count} charts into ${POST}`);
