// Asset/codegen-serving plumbing for the Bun dev server, split out of
// createDevServer.ts (the routing factory registers these against the resolved
// content/engine paths). This is the dev side of the dev↔prod serving parity:
//   - serveFromDir: the generated audio + manifest byte server (stable-name →
//     content-addressed-file resolution, ETag, and the 206/416/If-Range/304
//     handoff to server/serveAsset.ts — see the prod twin `applyRangeSupport`
//     in createWorker.ts / server/workerAssets.ts).
//   - serveMarkdown / serveFigureSource: the on-the-fly codegen twins (the
//     `/posts/<slug>.md` Copy-as-Markdown export and the figure-source files),
//     rendered per request from source because dev has no dist/.
// The `paths` these codegen twins used to close over is threaded in as a param
// so they stay free of the factory closure.
//
// methodology.md → "Serving generated audio" / "Dev server HTTP range support"
// / the two entry-point factories (server/createDevServer.ts).

import { StatusCodes } from "http-status-codes";
import { basename, dirname, extname, join, normalize } from "node:path";
import {
  findFullAudioName,
  findManifestName,
  isContentHashedAsset,
} from "../shared/manifestFile.ts";
import {
  audioEtag,
  HASHED_AUDIO_RE,
  stableEpisodePath,
} from "../shared/stableAudio.ts";
import { isSha256Hex } from "../shared/audioDigest.ts";
import {
  conditionalNotModified,
  serveAsset,
  stableEpisodeResponseHeaders,
  type AssetSource,
} from "./serveAsset.ts";
import type { BlogPaths } from "../shared/blogPaths.ts";
import { buildPublicPostVersionsMap } from "../shared/publicPostVersions.ts";
import { htmlToMarkdown, renderMarkdownDocument, type FrontMatter } from "../shared/htmlToMarkdown.ts";
import { resolveLicenseConfig } from "../shared/licenseConfig.ts";
import { isValidFigureSrc, spdxHeader } from "../shared/figureSource.ts";

/** Read a post's full audio SHA-256 (for Repr-Digest) from its manifest, or null. */
async function readEpisodeDigest(dir: string): Promise<string | null> {
  const name = await findManifestName(dir);
  if (!name) return null;
  try {
    const m = (await Bun.file(join(dir, name)).json()) as { audioDigest?: unknown };
    return typeof m.audioDigest === "string" && isSha256Hex(m.audioDigest)
      ? m.audioDigest
      : null;
  } catch {
    return null;
  }
}

// Serve files from a fixed directory — used for the generated audio +
// manifest, which Bun's bundler doesn't manage.
export function serveFromDir(dir: string, urlPrefix: string) {
  return async (req: Bun.BunRequest) => {
    const url = new URL(req.url);
    const sub = decodeURIComponent(url.pathname.replace(`/${urlPrefix}/`, ""));
    const safe = normalize(sub);
    if (safe.startsWith("..") || safe.includes("\0")) {
      return new Response("forbidden", { status: StatusCodes.FORBIDDEN });
    }
    // Stable AUTHORED names resolve to the current content-addressed file on
    // disk (dev serves the authored tree; the hash rewrite is a prod-build
    // step). Two such names: the player's bare `manifest.json` →
    // `manifest.<hash>.json`, and the shareable `episode.<ext>` →
    // `full.<hash>.<ext>` (the stable URL — see shared/stableAudio.ts). The
    // resolved episode carries a strong ETag so dev mirrors prod's revalidation.
    const base = basename(safe);
    const isEpisode = /^episode\.[a-z0-9]+$/i.test(base);
    let episodeEtag: string | null = null;
    let episodeDigest: string | null = null;
    let file = Bun.file(join(dir, safe));
    if (!(await file.exists())) {
      let resolved: string | null = null;
      if (base === "manifest.json") {
        resolved = await findManifestName(join(dir, dirname(safe)));
        if (resolved === "manifest.json") resolved = null; // bare miss → 404
      } else if (isEpisode) {
        resolved = await findFullAudioName(join(dir, dirname(safe)), extname(base));
      }
      if (resolved) file = Bun.file(join(dir, dirname(safe), resolved));
      if (!(await file.exists())) return new Response("not found", { status: StatusCodes.NOT_FOUND });
      if (isEpisode && resolved) {
        episodeEtag = audioEtag(resolved);
        episodeDigest = await readEpisodeDigest(join(dir, dirname(safe)));
      }
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
    // The ETag/Range/206/416/If-Range/304 orchestration below lives in
    // server/serveAsset.ts — the single owner both this dev server and the
    // prod Worker delegate to. NOTE: prod must implement the same `206`
    // support itself because the Workers `env.ASSETS` binding ignores `Range`
    // and returns the whole file, which breaks audio seeking; see
    // `applyRangeSupport` in server/workerAssets.ts, which wraps the same
    // serveAsset to reach parity.
    const isContentHashed = isContentHashedAsset(base); // D3: shared predicate
    // The stable `episode.<ext>` gets the revalidating policy (strong ETag +
    // no-cache + CDN-Cache-Control + Repr-Digest) shared with prod; everything
    // else keeps the immutable-vs-no-store split.
    const baseHeaders: Record<string, string> = isEpisode
      ? stableEpisodeResponseHeaders({
          etag: episodeEtag,
          slug: basename(dirname(safe)),
          ext: extname(base),
          digest: episodeDigest,
        })
      : {
          "Cache-Control": isContentHashed
            ? "public, max-age=31536000, immutable"
            : "no-store",
          "Accept-Ranges": "bytes",
        };
    // The hashed audio representation names its stable URL as canonical
    // (RFC 8288 + RFC 6596) — mirrors the prod Worker (createWorker.ts);
    // path-relative URI, resolved against the request URI per RFC 8288.
    if (HASHED_AUDIO_RE.test(safe)) {
      baseHeaders["Link"] = `<${stableEpisodePath(`/generated/${safe}`)}>; rel="canonical"`;
    }
    // Conditional GET on the stable URL → 304 (echoing the cache headers).
    // episodeEtag is null for non-episode assets ⇒ conditionalNotModified
    // returns null (same as the old `isEpisode &&` guard).
    const notMod = conditionalNotModified(req.headers, episodeEtag, baseHeaders);
    if (notMod) return notMod;
    const src: AssetSource = {
      size,
      slice: (s, e) => file.slice(s, e + 1), // Bun slice end is EXCLUSIVE
      whole: () => file,
    };
    return serveAsset(src, {
      method: req.method,
      requestHeaders: req.headers,
      headers: baseHeaders,
      ifRange: isEpisode
        ? { kind: "strong-etag", etag: episodeEtag }
        : { kind: "ignore" },
    });
  };
}

// `/posts/<slug>.md` — the "Copy as Markdown" twin. In prod this is a static
// file emitted by generate/markdown-export.ts and served by ASSETS; dev has
// no dist/, so we generate it on the fly from the source post HTML using the
// same shared transform (built fresh per request, like the byline JSON, so an
// edit shows up on reload without a restart). Bun's static routes can't carry
// the `.md` extension on the `/posts/<slug>` keys, so this lives in the
// catch-all below rather than the routes map.
export async function serveMarkdown(req: Bun.BunRequest, paths: BlogPaths): Promise<Response | null> {
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
  // Absolute figure-source base: the post's own origin + path, so
  // the `[source]` links are self-contained URLs (matching prod's SITE_URL form,
  // just on localhost) rather than relative paths that break when the `.md` is
  // copied as text. serveFigureSource below serves the targets on the fly.
  const extract = htmlToMarkdown(await file.text(), {
    figureSrcBase: `${url.origin}/posts/${safe}`,
  });
  const fm: FrontMatter = {
    title: extract.title,
    url: `${url.origin}/posts/${safe}`,
  };
  // Last-updated parity with the byline: the newest builtAt from versions.json.
  const versionMap = await buildPublicPostVersionsMap(paths.versionsJson);
  const updated = versionMap[`/posts/${safe}`]?.lastUpdated;
  if (updated) fm.updated = updated;
  // License front-matter parity with markdown-export.ts.
  const license = resolveLicenseConfig();
  if (license.content) fm.license = license.content.id;
  if (license.code) fm.codeLicense = license.code.id;
  return new Response(renderMarkdownDocument(extract, fm), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// `/posts/<slug>/figures/<module>.{ts,css}` — the figure-source twin (proposal
// 58). Prod emits these as static files under each post (figure-source-export.ts);
// dev has no dist/, so serve the authored source from the content repo's
// `figures/` on the fly — with the same SPDX header — so the `[source]` links in
// the generated `.md` resolve identically on localhost. Figures are a flat,
// blog-global dir, so the `<slug>` path segment is routing only; the module name
// is what's served (validated as a safe basename — no traversal).
export async function serveFigureSource(req: Bun.BunRequest, paths: BlogPaths): Promise<Response | null> {
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/posts\/[^/]+\/figures\/([^/]+)\.(ts|css)$/);
  if (!m) return null;
  const name = decodeURIComponent(m[1]!);
  const ext = m[2] as "ts" | "css";
  if (!isValidFigureSrc(name)) {
    return new Response("forbidden", { status: StatusCodes.FORBIDDEN });
  }
  const file = Bun.file(join(paths.contentRoot, "figures", `${name}.${ext}`));
  if (!(await file.exists())) {
    return new Response("not found", { status: StatusCodes.NOT_FOUND });
  }
  const license = resolveLicenseConfig();
  const body = spdxHeader(license.code, ext) + (await file.text());
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
