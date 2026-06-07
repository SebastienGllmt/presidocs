// Guards the SW range de-dup: the resolver copy-static splices into client/sw.js
// must behave identically to the ONE shared resolver in shared/httpRange.ts (the
// same parser the dev server + prod Worker use). This is the lock that the third
// hand-rolled copy stays gone — and that the `bytes=-` drift the de-dup fixed
// (the old SW copy returned 416 where the shared module returns "none" → 200)
// can't silently come back.

import { test, expect } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { resolveRange } from "../shared/httpRange.ts";
import {
  HTTP_RANGE_END,
  HTTP_RANGE_START,
  renderHttpRangeForSw,
  spliceHttpRangeIntoSw,
} from "./swHttpRange.ts";

const ENGINE = join(import.meta.dir, "..");
const swText = readFileSync(join(ENGINE, "client/sw.js"), "utf8");
const httpRangeSrc = readFileSync(join(ENGINE, "shared/httpRange.ts"), "utf8");

// Reproduce exactly what copy-static.ts ships: the authored sw.js with the
// shared resolver spliced in.
function shippedSw(): string {
  return spliceHttpRangeIntoSw(swText, renderHttpRangeForSw(httpRangeSrc));
}

// Extract the spliced range block and evaluate it to get its resolveRange.
// `new Function` returns the three resolver functions; none of them touch SW
// globals (caches/fetch live in cacheFirstRanged, not here), so this is safe.
function shippedResolveRange(): (h: string | null, size: number) => unknown {
  const shipped = shippedSw();
  const start = shipped.indexOf(HTTP_RANGE_START) + HTTP_RANGE_START.length;
  const end = shipped.indexOf(HTTP_RANGE_END);
  const block = shipped.slice(start, end);
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${block}\nreturn resolveRange;`);
  return factory();
}

test("the splice markers exist in client/sw.js", () => {
  expect(swText).toContain(HTTP_RANGE_START);
  expect(swText).toContain(HTTP_RANGE_END);
});

test("spliceHttpRangeIntoSw throws if the markers are missing", () => {
  expect(() => spliceHttpRangeIntoSw("no markers here", "x")).toThrow(/markers/);
});

test("the rendered range JS has no leftover ESM exports", () => {
  const rendered = renderHttpRangeForSw(httpRangeSrc);
  expect(/(^|\s)export\s/.test(rendered)).toBe(false);
  expect(rendered).toContain("function resolveRange");
  expect(rendered).toContain("function contentRangeHeader");
  expect(rendered).toContain("function unsatisfiedRangeHeader");
});

test("the SHIPPED SW resolveRange matches shared/httpRange.ts across the range table", () => {
  const swResolve = shippedResolveRange();
  const SIZE = 1000;
  const headers: (string | null)[] = [
    null,
    "",
    "bytes=0-99", // normal range
    "bytes=500-", // open-ended
    "bytes=-100", // suffix
    "bytes=-0", // valid-but-unsatisfiable suffix → 416
    "bytes=-", // syntactically invalid → none → 200 (the drift the SW had wrong)
    "bytes=999-999", // last byte
    "bytes=1000-1001", // wholly past the end → unsatisfiable
    "bytes=200-100", // start > end → unsatisfiable
    "garbage",
  ];
  for (const h of headers) {
    expect(swResolve(h, SIZE)).toEqual(resolveRange(h, SIZE) as unknown as object);
  }
});

test("the `bytes=-` drift is fixed: SW now resolves it to none (full 200), not 416", () => {
  const swResolve = shippedResolveRange();
  expect(swResolve("bytes=-", 1000)).toEqual({ kind: "none" });
  // and the valid-but-unsatisfiable suffix still 416s, as the shared module does
  expect(swResolve("bytes=-0", 1000)).toEqual({ kind: "unsatisfiable", size: 1000 });
});
