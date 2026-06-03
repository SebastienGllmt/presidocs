// Engine factory for the Bun dev server. The route wiring used to live inline
// in `index.ts`; it's factored here so every content repo keeps only a thin
// `index.ts` that statically imports its own post HTML bundles (so Bun's
// bundler + HMR can process them) and hands them to this factory as
// `staticRoutes`. Everything else — auth, comments, post-version, the generated
// audio + WASM static routes, the dev-only regenerate endpoint — is wired here
// against the resolved content/engine paths.
//
// Mirrors the production route table (server/createWorker.ts) so dev and prod
// resolve the same URLs the same way.

import { StatusCodes } from "http-status-codes";
import { basename, dirname, join, normalize } from "node:path";
import { getPlatformProxy } from "wrangler";
import {
  startGoogleAuth,
  startMicrosoftAuth,
  googleCallback,
  microsoftCallback,
  whoami,
  logout,
} from "./auth/routes.ts";
import { handleCommentsRequest } from "./comments/routes.ts";
import { handleResolutionsRequest } from "./comments/resolutionsRoutes.ts";
import { r2Adapter } from "./comments/r2Adapter.ts";
import type { Env } from "./env.ts";
import { loadDevPostMetaIndex } from "./postMeta.dev.ts";
import { loadDevPostVersionIndex } from "./postVersions.dev.ts";
import { handlePostVersionRequest } from "./postVersionsRoute.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import { handleAnalyticsRequest } from "./analyticsRoute.ts";
import { handleRegenerateRequest } from "./regenerate.dev.ts";
import { handleSoundTestList, handleSoundTestRegenerate } from "./soundTest.dev.ts";
import { withSecurityHeaders } from "../shared/securityHeaders.ts";
import { buildAuthorMap } from "../shared/authorProfile.ts";
import { buildPublicPostVersionsMap } from "../shared/publicPostVersions.ts";
import { htmlToMarkdown, renderMarkdownDocument, type FrontMatter } from "../shared/htmlToMarkdown.ts";
import type { BlogPaths } from "../shared/blogPaths.ts";
import { findManifestName } from "../shared/manifestFile.ts";
import {
  contentRangeHeader,
  resolveRange,
  unsatisfiedRangeHeader,
} from "../shared/httpRange.ts";
// Dev-only sound-test page. A static HTML bundle imported here (not in the
// content repo's index.ts) because it's an engine surface, not blog content;
// importing it from createDevServer keeps it out of the prod Worker bundle
// (worker.ts → createWorker.ts never reaches this module).
import soundTestPage from "../client/sound-test/index.html";

// Register the Miniflare proxy's dispose() so the local R2 / Rate Limiter
// subprocess is shut down cleanly when the dev server exits. Wired once per
// process — a second createDevServer() call (we don't have one today) would
// re-register harmlessly. SIGINT/SIGTERM are the two Bun's `--hot` and
// scripts/dev.ts send.
let disposeRegistered = false;
function registerProxyDisposeOnExit(dispose: () => Promise<void>): void {
  if (disposeRegistered) return;
  disposeRegistered = true;
  const shutdown = async (signal: NodeJS.Signals) => {
    try {
      await dispose();
    } catch (err) {
      console.warn(`[dev] proxy dispose failed: ${(err as Error).message}`);
    }
    process.exit(signal === "SIGTERM" ? 143 : 130);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

export type DevServerOptions = {
  paths: BlogPaths;
  // The content repo's statically-imported HTML bundles, keyed by URL path:
  //   { "/": landing, "/posts/hash-functions": hashFunctions, … }
  // Kept in the content repo's index.ts because Bun's bundler/HMR needs these
  // imports to be static (a glob/codegen produces the import list — see
  // generate/post-routes.ts).
  staticRoutes: Record<string, Bun.HTMLBundle>;
  port?: number;
};

type DevHandler = (req: Bun.BunRequest) => Response | Promise<Response>;

export async function createDevServer(opts: DevServerOptions) {
  const { paths, staticRoutes } = opts;

  // Wrap a function-style route handler so its response carries the security
  // headers (parity with the Worker). `priv` additionally sets CORP for the
  // non-asset API responses. The HTMLBundle routes are served by Bun's bundler
  // and can't be wrapped — see shared/securityHeaders.ts; the document CSP is
  // verified against the Worker (`wrangler dev`), not this dev server.
  const pub = (h: DevHandler): DevHandler => async (req) =>
    withSecurityHeaders(await h(req));
  const priv = (h: DevHandler): DevHandler => async (req) =>
    withSecurityHeaders(await h(req), { private: true });

  // Dev-mode bindings: spin up a Miniflare-backed proxy that resolves the
  // content repo's wrangler.toml. The same prod handlers (r2Adapter,
  // handleCommentsRequest) then run in dev against real local R2 + the real
  // Rate Limiting binding — closing the "two stores can silently disagree on
  // semantics" gap and the "dev never exercised the 429 path" gap. `dispose()`
  // is wired below to shut the Miniflare subprocess down on signal.
  //
  // Failure to construct the proxy (malformed wrangler.toml, missing bindings)
  // is loud at startup, not a silent fallback to a divergent in-memory shape.
  //
  // Note: `server/comments/fsAdapter.ts` is still kept for the offline author
  // tooling (authoring/resolveThreads.ts, loadUnresolvedThreads.ts,
  // exportAnnotations.ts, r2Sync.ts) that operates on the on-disk dev store
  // outside this server. Dev-server writes now land in Miniflare R2
  // (.wrangler/state/v3/r2/) instead — author flows that want them locally
  // should run `bun run pull-comments` against prod R2 as before.
  // PRESIDOCS_DEV_STATE_DIR overrides where Miniflare persists its local
  // bindings (R2 comment store, rate limiter). Unset in normal dev → the
  // wrangler default (`.wrangler/state/v3`), shared with `dev:edge` so a
  // developer's writes survive restarts. The e2e harness sets it to a fresh
  // throwaway temp dir per run (see e2e/harness.ts) so seeded comments are
  // isolated by construction — they never land in the interactive dev store
  // (where the author aggregator would surface them) and never accumulate
  // across runs. See methodology.md → Dev server wrapper.
  const stateDir = process.env.PRESIDOCS_DEV_STATE_DIR;
  const proxy = await getPlatformProxy<Env>({
    configPath: join(paths.contentRoot, "wrangler.toml"),
    ...(stateDir ? { persist: { path: stateDir } } : {}),
  });
  registerProxyDisposeOnExit(proxy.dispose);
  const commentsDevStore = r2Adapter(proxy.env.COMMENTS);

  // Per-post author index — scans the content repo's posts/*.html at startup,
  // so a new post is picked up after a server restart (no build step required).
  const postMetaIndex = await loadDevPostMetaIndex(paths.postsDir);

  // Per-post version index — current SHA-256 of source HTML (computed fresh at
  // dev startup so a saved edit picks up immediately) plus any history
  // persisted to posts/versions.json by the build script.
  const postVersionsIndex = await loadDevPostVersionIndex(
    paths.postsDir,
    paths.versionsJson,
  );

  // Serve files from a fixed directory — used for the generated audio +
  // manifest, which Bun's bundler doesn't manage.
  function serveFromDir(dir: string, urlPrefix: string) {
    return async (req: Bun.BunRequest) => {
      const url = new URL(req.url);
      const sub = decodeURIComponent(url.pathname.replace(`/${urlPrefix}/`, ""));
      const safe = normalize(sub);
      if (safe.startsWith("..") || safe.includes("\0")) {
        return new Response("forbidden", { status: StatusCodes.FORBIDDEN });
      }
      let file = Bun.file(join(dir, safe));
      if (!(await file.exists())) {
        // The played manifest is content-addressed (`manifest.<hash>.json`).
        // Dev serves the AUTHORED HTML, whose `data-narration-src` still names
        // the bare `manifest.json` (the hash rewrite is a prod-build step), so
        // resolve a bare request to the hashed file on disk. Served no-store
        // below since the request URL itself isn't hashed in dev (harmless —
        // dev registers no service worker and sits behind no CDN).
        const resolved = basename(safe) === "manifest.json"
          ? await findManifestName(join(dir, dirname(safe)))
          : null;
        if (resolved && resolved !== "manifest.json") {
          file = Bun.file(join(dir, dirname(safe), resolved));
        }
        if (!(await file.exists())) return new Response("not found", { status: StatusCodes.NOT_FOUND });
      }
      const size = file.size;
      // Cache policy is split by whether the filename is content-addressed.
      //
      // The full audio track ships as `full.<hash>.<ext>` (see generate.ts):
      // its URL changes whenever its bytes change, so it is safe — and
      // better — to let the browser CACHE IT IMMUTABLY rather than re-download
      // a ~20 MB file on every reload. `no-store` (the old blanket policy here)
      // also stops the media element from retaining the byte ranges it has
      // fetched, so it can't reuse them across seeks. (`immutable` is honored
      // even by a media cache that ignores plain revalidation.)
      //
      // Everything else here is STABLE-NAMED and must never be served stale:
      // `manifest.json` (the player reads the current `full.<hash>` URL out of
      // it — a stale copy would point at a swept hash and 404) and the dev
      // comment store. `no-store` (not `no-cache`: we send no ETag/Last-Modified
      // validator to revalidate against). Refetch cost is nil on localhost.
      //
      // The `Accept-Ranges`/range handling below lets the media element seek
      // into (and start playing) large audio: without it a multi-MB track is
      // served as one unbounded chunked stream with no length, which Chrome
      // refuses to begin playing. NOTE: prod must implement the same `206`
      // itself — the Workers `env.ASSETS` binding ignores `Range` and returns
      // the whole file, which breaks seeking; see `applyRangeSupport` in
      // createWorker.ts. Small files happened to work anyway because the
      // browser buffers them whole. The parser is shared with the prod path
      // via shared/httpRange.ts.
      const isContentHashed =
        /(^|\/)(full\.[0-9a-f]{16}\.[a-z0-9]+|manifest\.[0-9a-f]{16}\.json)$/i.test(safe);
      const baseHeaders: Record<string, string> = {
        "Cache-Control": isContentHashed
          ? "public, max-age=31536000, immutable"
          : "no-store",
        "Accept-Ranges": "bytes",
      };
      const outcome = resolveRange(req.headers.get("range"), size);
      if (outcome.kind === "unsatisfiable") {
        return new Response("range not satisfiable", {
          status: StatusCodes.REQUESTED_RANGE_NOT_SATISFIABLE,
          headers: {
            ...baseHeaders,
            "Content-Range": unsatisfiedRangeHeader(outcome.size),
          },
        });
      }
      if (outcome.kind === "satisfiable") {
        const { start, end } = outcome;
        return new Response(file.slice(start, end + 1), {
          status: StatusCodes.PARTIAL_CONTENT,
          headers: {
            ...baseHeaders,
            "Content-Range": contentRangeHeader(start, end, outcome.size),
            "Content-Length": String(end - start + 1),
          },
        });
      }
      return new Response(file, {
        headers: { ...baseHeaders, "Content-Length": String(size) },
      });
    };
  }

  const apiRoutes: Record<string, DevHandler | { POST: DevHandler }> = {
    "/generated/*": pub(serveFromDir(paths.generatedDir, "generated")),
    "/assets/automerge.wasm": pub(async () =>
      new Response(Bun.file(paths.automergeWasm), {
        headers: {
          "Content-Type": "application/wasm",
          "Cache-Control": "public, max-age=2592000, immutable",
        },
      })),
    // PWA surface (see methodology → Offline / PWA). The Bun inner loop does NOT register the
    // SW (swRegister.ts gates on `typeof __BUN_DEV__ === "undefined"`), so
    // these routes are dormant on `bun run dev` — they exist for parity with
    // `dev:edge` (wrangler dev) and for anyone exercising the URLs manually.
    //
    // Engine-owned: SW source (reusable across blogs, no per-blog values).
    // __SW_VERSION__ is left un-substituted in dev — the placeholder is
    // harmless because the SW never registers here.
    "/sw.js": pub(async () =>
      new Response(Bun.file(join(paths.engineRoot, "client/sw.js")), {
        headers: {
          "Content-Type": "application/javascript",
          // Never let the browser cache the SW itself, or a stale SW will
          // sit in front of a deployed new one.
          "Cache-Control": "no-cache",
          // Lets the SW claim a wider scope than its URL. Not needed for
          // "/" but documented in case we relocate sw.js later.
          "Service-Worker-Allowed": "/",
        },
      })),
    // Content-owned: per-blog manifest. Missing → 404; the SW (when it
    // registers) and offline still work, just no install affordance.
    "/manifest.webmanifest": pub(async () => {
      const file = Bun.file(join(paths.contentRoot, "manifest.webmanifest"));
      if (!(await file.exists())) return new Response("not found", { status: StatusCodes.NOT_FOUND });
      return new Response(file, {
        headers: { "Content-Type": "application/manifest+json" },
      });
    }),
    // Content-owned: per-blog icons.
    "/icons/*": pub(serveFromDir(join(paths.contentRoot, "icons"), "icons")),
    // Author byline data (client/byline.ts fetches this). Built fresh per
    // request from the same `buildAuthorMap` the prod build uses, so a new post
    // or edited profile shows up on reload without a restart. The map carries
    // NO email — only public name/links/avatar-URL. Prod serves the identical
    // file written into dist/assets by copy-static.ts.
    "/assets/authors.json": pub(async () => {
      const { map } = await buildAuthorMap(paths.postsDir, paths.contentRoot);
      return new Response(JSON.stringify(map), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }),
    // Public per-post last-updated date (client/byline.ts fetches this). Built
    // fresh per request from posts/versions.json — the same source the prod
    // build reads — so a new commit's builtAt picks up on reload without a
    // restart. Public counterpart to the gated /post-version endpoint; carries
    // no hash, only the most recent ISO timestamp.
    "/assets/post-versions.json": pub(async () => {
      const map = await buildPublicPostVersionsMap(paths.versionsJson);
      return new Response(JSON.stringify(map), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }),
    // Avatars, served under the PUBLIC handle (`<handle>.<ext>`) — never the
    // email. The on-disk source is `authors/<email>.<ext>`; buildAuthorMap maps
    // the public served name back to that source path.
    "/assets/authors/*": pub(async (req) => {
      const file = decodeURIComponent(
        new URL(req.url).pathname.replace("/assets/authors/", ""),
      );
      const { avatars } = await buildAuthorMap(paths.postsDir, paths.contentRoot);
      const srcPath = avatars[file];
      if (!srcPath) return new Response("not found", { status: StatusCodes.NOT_FOUND });
      return new Response(Bun.file(srcPath), {
        headers: { "Cache-Control": "no-store" },
      });
    }),
    "/auth/google": priv(startGoogleAuth),
    "/auth/google/callback": priv(googleCallback),
    "/auth/microsoft": priv(startMicrosoftAuth),
    "/auth/microsoft/callback": priv(microsoftCallback),
    "/auth/me": priv(whoami),
    "/auth/logout": { POST: priv(logout) },
    "/openapi.json": pub(() => Response.json(buildOpenApiDocument())),
    "/comments": priv((req) =>
      handleCommentsRequest(req, {
        store: commentsDevStore,
        postMeta: postMetaIndex,
        rateLimiter: proxy.env.RATE_LIMITER,
      })),
    "/resolutions": priv((req) =>
      handleResolutionsRequest(req, {
        store: commentsDevStore,
        postMeta: postMetaIndex,
      })),
    "/post-version": priv((req) =>
      handlePostVersionRequest(req, {
        postVersions: postVersionsIndex,
        postMeta: postMetaIndex,
      })),
    // Engagement-analytics sink. No-op in dev: `sink: null` means the route
    // validates + 204s but never calls writeDataPoint, so a developer's clicks
    // don't pollute the prod dataset. Same path as prod for parity (the
    // client beacon target is identical in both runtimes).
    "/_a": pub((req) =>
      handleAnalyticsRequest(req, {
        sink: null,
        postMeta: postMetaIndex,
        rateLimiter: null,
      })),
    // Dev-only, author-only: re-roll one segment's audio by shelling out to the
    // offline generate pipeline. Absent from the Worker (the prod edge server
    // stays dumb and never runs the build).
    "/dev/regenerate": priv((req) =>
      handleRegenerateRequest(req, {
        contentRoot: paths.contentRoot,
        engineRoot: paths.engineRoot,
        postMeta: postMetaIndex,
      })),
    // Dev-only sound-test endpoints: list the common-terms.pls lexemes and
    // re-roll their production-voice audio. Like /dev/regenerate, these shell
    // out to the offline MOSS pipeline and are absent from the Worker.
    "/dev/sound-test/list": priv((req) =>
      handleSoundTestList(req, {
        contentRoot: paths.contentRoot,
        engineRoot: paths.engineRoot,
        postMeta: postMetaIndex,
      })),
    "/dev/sound-test/regenerate": priv((req) =>
      handleSoundTestRegenerate(req, {
        contentRoot: paths.contentRoot,
        engineRoot: paths.engineRoot,
        postMeta: postMetaIndex,
      })),
  };

  // The sound-test page itself is an HTMLBundle (Bun bundles its TS/CSS), served
  // only by the dev server. Kept separate from the function `apiRoutes` map
  // because its value is a bundle, not a handler.
  const pageRoutes: Record<string, Bun.HTMLBundle> = {
    "/dev/sound-test": soundTestPage,
  };

  // `/posts/<slug>.md` — the "Copy as Markdown" twin. In prod this is a static
  // file emitted by generate/markdown-export.ts and served by ASSETS; dev has
  // no dist/, so we generate it on the fly from the source post HTML using the
  // same shared transform (built fresh per request, like the byline JSON, so an
  // edit shows up on reload without a restart). Bun's static routes can't carry
  // the `.md` extension on the `/posts/<slug>` keys, so this lives in the
  // catch-all below rather than the routes map.
  async function serveMarkdown(req: Bun.BunRequest): Promise<Response | null> {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/posts\/(.+)\.md$/);
    if (!m) return null;
    const slug = decodeURIComponent(m[1]!);
    const safe = normalize(slug);
    if (safe.startsWith("..") || safe.includes("\0")) {
      return new Response("forbidden", { status: StatusCodes.FORBIDDEN });
    }
    const file = Bun.file(join(paths.postsDir, `${safe}.html`));
    if (!(await file.exists())) {
      return new Response("not found", { status: StatusCodes.NOT_FOUND });
    }
    const extract = htmlToMarkdown(await file.text());
    const fm: FrontMatter = {
      title: extract.title,
      url: `${url.origin}/posts/${safe}`,
    };
    // Last-updated parity with the byline: the newest builtAt from versions.json.
    const versionMap = await buildPublicPostVersionsMap(paths.versionsJson);
    const updated = versionMap[`/posts/${safe}`]?.lastUpdated;
    if (updated) fm.updated = updated;
    return new Response(renderMarkdownDocument(extract, fm), {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  return {
    port: opts.port ?? Number(process.env.PORT ?? 3000),
    // Static post/landing bundles + the dev-only page bundle first, then the
    // function API routes.
    routes: { ...staticRoutes, ...pageRoutes, ...apiRoutes },
    development: { hmr: true, console: true },
    async fetch(req: Bun.BunRequest) {
      const md = await serveMarkdown(req);
      if (md) return withSecurityHeaders(md);
      return new Response("not found", { status: StatusCodes.NOT_FOUND });
    },
  };
}
