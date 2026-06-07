// Broken-link / dead-fragment gate — validates that every internal `<a href>`
// and every author-written `#fragment` in the built site actually resolves.
// There is no other link/anchor validation anywhere in the engine: the build-time
// `audit-posts.ts` gate checks title/lang/meta-description/one-main/img-alt and
// nothing href-shaped. So a renamed post slug, a moved asset, or a renamed
// `<mark>`-keyed heading id silently ships a 404 today.
//
// Why the wrangler tier (and NOT a static crawl of `dist/`): the site's internal
// links are EXTENSIONLESS (`/posts/<slug>`, `/help`, `/privacy`) and resolve only
// through Cloudflare Workers Static Assets `html_handling` (createWorker.ts's
// static-asset fall-through). A linkinator crawl of the `dist/` directory would
// 404 every page link, because its bundled static server doesn't do that mapping.
// The obvious fix — rewriting extensionless→`.html` with linkinator's
// `urlRewriteExpressions` — makes the pages reachable but DEFEATS `--check-fragments`
// (the rewritten deep-links collapse and a dead `#fragment` slips through, verified).
// Since this site's deep-links are BOTH extensionless AND fragment-bearing
// (`/posts/<slug>#some-heading`), the only way to validate them faithfully is to
// crawl the REAL worker, where `html_handling` resolves the path natively and the
// `.html` response is what the fragment check sees. So this drives the built worker
// under `wrangler dev` (startWranglerServer = `bun run build` + `wrangler dev`),
// exactly the tier cspConsole.ts / prodAudioSmoke.ts use for prod-only behaviour.
//
// Coverage boundary (honest scope): this validates the AUTHOR-WRITTEN id/href layer
// (`#problem-heading`, `#oq1-what`, hand-written intra-post anchors, the
// `<mark>`↔heading wiring) and inter-page/asset links — all present in the served
// HTML. It does NOT cover the heading slugs that `client/headerLinks.ts` backfills
// at runtime in the browser (e.g. a link to an auto-derived `#some-heading-text`):
// those ids don't exist in the server-rendered HTML the crawler sees, so they're
// out of scope here (and rarely the target of a hand-written href — authors who
// want a stable deep-link target write an explicit id, which IS checked). Closing
// that residual would require emitting heading ids at build time — a separate change.
//
// External links are SKIPPED in this (publish-blocking) lane: checking them would
// make the gate non-deterministic (a third-party 503 fails *our* build) and emit
// requests to third parties from the build host (a privacy leak inconsistent with
// the no-third-party-request stance). Internal reachability is the invariant; an
// external-liveness report, if ever wanted, belongs in a separate non-blocking lane.
//
// NOT named `*.e2e.ts` on purpose: like cspConsole.ts / serviceWorker.ts /
// prodAudioSmoke.ts it's a heavy tier (a full build + wrangler boot), run only via
// its own script — `bun run test:e2e:links` — never the default `bun test` or the
// Chrome `test:e2e` lane. `PRESIDOCS_E2E_SKIP_BUILD=1` reuses an existing fresh
// `dist/` for faster local iteration (skips the build's source-post rewrite).
//
// Precondition: the harness runs `bun run build`, which rewrites source posts
// (managed <script> tags) + versions.json per normal build behaviour — run on an
// ephemeral/CI checkout, or `git checkout` those afterward.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { LinkChecker, LinkState } from "linkinator";
import { startWranglerServer, type BlogServer } from "./harness.ts";

let server: BlogServer;

beforeAll(async () => {
  server = await startWranglerServer();
}, 300_000);

afterAll(async () => {
  await server?.stop();
});

// Skip anything that isn't on the local worker origin — i.e. real external
// http(s). The worker serves on 127.0.0.1, so internal links stay in scope.
function isExternal(link: string): boolean {
  return /^https?:\/\/(?!(127\.0\.0\.1|localhost)(?:[:/]|$))/i.test(link);
}

test("no broken internal links or dead author fragments in the built site", async () => {
  const result = await new LinkChecker().check({
    path: server.baseURL,
    recurse: true, // follow internal links across the whole built site
    checkFragments: true, // a `#fragment` must resolve to an id in the target HTML
    // The worker serves extensionless URLs (`/posts/<slug>`) directly — the same
    // clean-URL model as `html_handling`. Without this, linkinator appends a
    // trailing slash to extensionless HTML URLs for relative-link resolution
    // (url-utils.ts normalizeBaseUrl), which makes a post's relative asset refs
    // (`../chunk-*.css`) resolve one directory too deep (`/posts/chunk-*` → 404).
    // `cleanUrls` treats extensionless URLs as files, matching how the worker
    // (and a real browser) resolve them, so relative assets land at the root.
    cleanUrls: true,
    linksToSkip: (link) => Promise.resolve(isExternal(link)),
  });

  const broken = result.links.filter((l) => l.state === LinkState.BROKEN);
  if (broken.length > 0) {
    console.error(`\nbroken-link gate: ${broken.length} dead internal link(s)/fragment(s):`);
    for (const b of broken) {
      console.error(`  ✗ [${b.status ?? "?"}] ${b.url}${b.parent ? `  (linked from ${b.parent})` : ""}`);
    }
  }
  expect(broken.map((b) => b.url)).toEqual([]);
}, 180_000);
