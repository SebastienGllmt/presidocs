// Copies build-time static artifacts into `dist/` so Cloudflare's
// Static Assets binding can serve them in prod alongside the bundled
// HTML/JS/CSS. Static here means "doesn't change at runtime" —
// the output of an offline build step or a vendored binary asset.
// Truly dynamic content (user comments) lives in R2, not here.
//
// What we copy:
//   - `generated/<slug>/manifest.<hash>.json` — narration timing manifest
//     (content-addressed; see shared/manifestFile.ts)
//   - `generated/<slug>/*.mp3`         — pre-rendered audio
//   - `generated/<slug>/captions.vtt`  — word-timed WebVTT transcript, served
//     and advertised via <podcast:transcript type="text/vtt"> (proposals/39)
//   - `node_modules/@automerge/automerge/dist/automerge.wasm` — the
//     Automerge WASM core the comments client lazy-loads.
//
// What we deliberately don't copy (lives in `generated/` but is
// build-internal, not served):
//   - `generated/.tts-cache/`    — TTS cache buckets
//   - `generated/.comments-dev/` — dev-only fs-adapter comment blobs
//   - `generated/<slug>/cache-keys.json` — GC index for the TTS cache
//
// PWA files (prod: bundle into dist/ — see methodology → Offline / PWA):
//   - engine/client/sw.js         → dist/sw.js (with __SW_VERSION__ replaced)
//   - <content>/manifest.webmanifest → dist/manifest.webmanifest
//   - <content>/icons/*           → dist/icons/*
//   - dist/_headers gets `/sw.js → no-cache` appended (engine policy)
//
// Runs as part of `bun run build` (between `bun build` and the HTML
// strip). Idempotent; safe to re-run.

import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { isPrivateBlog } from "../shared/blogPrivacy.ts";
import { buildAuthorMap } from "../shared/authorProfile.ts";
import { buildPublicPostVersionsMap } from "../shared/publicPostVersions.ts";
import { MANIFEST_HASHED_RE } from "../shared/manifestFile.ts";
import { renderHttpRangeForSw, spliceHttpRangeIntoSw } from "./swHttpRange.ts";

const paths = resolveBlogPaths();
const ROOT = paths.contentRoot;
const DIST = paths.distDir;
const ENGINE = paths.engineRoot;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// The include rule for `generated/<slug>/` files: ship the (content-addressed)
// timing manifest and the word-timed WebVTT transcript; everything else under
// `generated/` is build-internal (caches, dev comment blobs, GC indexes — see
// the header comment). Exact-name matches for `manifest.json`/`captions.vtt`
// keep the rule tight (no stray `.json`/`.vtt` swept in). Pure + exported so
// the rule is unit-testable.
//
// The full narration track (`full.<hash>.<ext>`) is deliberately NOT shipped:
// a long track can exceed Cloudflare's hard 25 MiB per-static-asset limit, so
// it's served from R2 by the Worker instead (env.AUDIO; createWorker.ts) and
// uploaded by the deploy step (generate/upload-audio-r2.ts).
export function shouldShipGeneratedFile(name: string): boolean {
  // Dotfiles (notably macOS AppleDouble `._*` sidecars) are never shipped.
  if (name.startsWith(".")) return false;
  return (
    MANIFEST_HASHED_RE.test(name) ||
    name === "manifest.json" ||
    name === "captions.vtt"
    // `full.<hash>.<ext>` audio → R2, not dist — see above.
    // The social-media video (`video.<hash>.mp4`, methodology.md → "Copying static artifacts") is a LOCAL
    // artifact only — NOT shipped to Cloudflare. The files are large and the
    // author uploads them to platforms by hand, so deploying/edge-serving them
    // would be pure waste; its `.json` sidecar is likewise build-internal. (To
    // edge-serve video again, re-add `VIDEO_HASHED_RE.test(name)` here plus the
    // `video/mp4` MIME + Range path in createWorker.ts.)
  );
}

// Cloudflare Workers Static Assets cap each individual file at 25 MiB (a hard,
// non-configurable platform limit). A build that ships an oversized file fails
// deep inside Miniflare/wrangler with an opaque stack trace that only surfaces
// at `bun run dev`/`wrangler deploy` and names a `dist/` path the author never
// wrote. We pre-empt that with a legible failure at the step that produced the
// tree. (The realistic offender — full narration tracks — is
// already routed to R2 above; this is the backstop for anything else, e.g. an
// outsized image.)
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

async function assertNoOversizedAssets(): Promise<void> {
  const offenders: { path: string; bytes: number }[] = [];
  async function walk(dir: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        const { size } = await stat(p);
        if (size > MAX_ASSET_BYTES) offenders.push({ path: p, bytes: size });
      }
    }
  }
  await walk(DIST);
  if (offenders.length === 0) return;
  const lines = offenders.map(
    (o) => `  ${relative(ROOT, o.path)} — ${(o.bytes / 1024 / 1024).toFixed(1)} MiB`,
  );
  throw new Error(
    `Cloudflare Workers caps static assets at 25 MiB; these dist/ files exceed it:\n${lines.join("\n")}\n` +
      `Audio tracks are served from R2 instead. For anything else, ` +
      `shrink the file or serve it from R2/object storage rather than the asset bundle.`,
  );
}

// Walks `generated/` and copies only the per-post audio + manifest +
// transcript files. Walking manually (rather than `cp -r` with a filter) keeps
// the include rule legible and avoids the surprising "filter returns
// false on a directory means we don't recurse into it" semantics of
// `fs.cp`.
async function copyGeneratedArtifacts(): Promise<number> {
  const src = join(ROOT, "generated");
  const dst = join(DIST, "generated");
  if (!(await exists(src))) {
    console.warn(
      `  generated/ does not exist — skipping (run \`bun run generate\` first if you want audio in the build)`,
    );
    return 0;
  }
  // Mirror, don't merge: wipe the served tree first so artifacts from a PRIOR
  // build can't linger in dist and get redeployed. This is load-bearing for
  // cache correctness — `cp` only ever ADDS, so a superseded `manifest.json`
  // (or an old `full.<hash>.mp3`) left behind stays live at its URL forever, and
  // any cache holding that URL keeps serving the stale/short track (the 0:15
  // bug). Hashing the manifest stops the CURRENT page from requesting it, but
  // only deleting the file stops the server from answering it at all.
  // `feeds.ts` re-writes each post's chapters.json into here after this step.
  await rm(dst, { recursive: true, force: true });
  let copied = 0;
  const topEntries = await readdir(src, { withFileTypes: true });
  for (const top of topEntries) {
    if (!top.isDirectory()) continue;
    // Skip build-internal hidden dirs (.tts-cache, .comments-dev, …).
    if (top.name.startsWith(".")) continue;

    const slugSrc = join(src, top.name);
    const slugDst = join(dst, top.name);
    const slugEntries = await readdir(slugSrc, { withFileTypes: true });
    let createdDst = false;
    for (const f of slugEntries) {
      if (!f.isFile()) continue;
      // Skip dotfiles — notably macOS AppleDouble sidecars (`._full.<hash>.mp3`),
      // which match the `.mp3` keep-rule but are just resource-fork metadata, not
      // audio. Shipping them is dead weight (and confusing breadcrumbs).
      if (f.name.startsWith(".")) continue;
      if (!shouldShipGeneratedFile(f.name)) continue;
      if (!createdDst) {
        await mkdir(slugDst, { recursive: true });
        createdDst = true;
      }
      await cp(join(slugSrc, f.name), join(slugDst, f.name));
      copied++;
    }
  }
  return copied;
}

async function copyAutomergeWasm(): Promise<boolean> {
  // Engine-owned vendored asset — resolves into the engine's node_modules even
  // when the build runs from an external content repo.
  const src = paths.automergeWasm;
  const dst = join(DIST, "assets", "automerge.wasm");
  if (!(await exists(src))) {
    console.warn(`  ${relative(ROOT, src)} not found — skipping WASM copy`);
    return false;
  }
  await mkdir(join(DIST, "assets"), { recursive: true });
  await cp(src, dst);
  return true;
}

// Author bylines: write the public author map the client byline fetches
// (`/assets/authors.json`, post path → {name, links, avatar}) and publish each
// author's avatar under its PUBLIC handle (`dist/assets/authors/<handle>.<ext>`)
// — never under the email, so the served byline can't re-leak the address the
// HTML strip removes. Dev produces the identical map/avatars from the same
// `buildAuthorMap`, so bylines match in dev and prod. See shared/authorProfile.ts.
// Self-hosted Red Hat woff2 → dist/fonts/. The prod build keeps each @font-face
// `url(./fonts/*.woff2)` external (build-html.ts `external: ["*.woff2"]`) instead
// of inlining it into every post's CSS chunk; the chunks sit at dist root, so
// `./fonts/x.woff2` resolves to `/fonts/x.woff2`, served from here as one
// cacheable file per face (fetched once, reused across all pages). Engine-owned
// (client/fonts), like the WASM asset. Dev doesn't need this — serve.static
// inlines the fonts there, which is fine.
async function copyFonts(): Promise<number> {
  const src = join(ENGINE, "client", "fonts");
  if (!(await exists(src))) {
    console.warn(`  ${relative(ROOT, src)} not found — skipping font copy`);
    return 0;
  }
  const dst = join(DIST, "fonts");
  await mkdir(dst, { recursive: true });
  let n = 0;
  for (const f of await readdir(src)) {
    // The woff2 AND OFL.txt beside them: SIL OFL 1.1 §2 requires the license to
    // accompany every redistributed copy of the Font Software, and self-hosting
    // the woff2 IS redistribution. (The woff2 name tables carry the copyright
    // notice + a license URL, but not the full license text — so we ship it as
    // the stand-alone file the OFL accepts, served at /fonts/OFL.txt.)
    if (!f.endsWith(".woff2") && f !== "OFL.txt") continue;
    await cp(join(src, f), join(dst, f));
    n++;
  }
  return n;
}

async function copyAuthorAssets(): Promise<number> {
  const { map, avatars } = await buildAuthorMap(
    paths.postsDir,
    ROOT,
    (msg) => console.warn(msg),
  );

  const assetsDir = join(DIST, "assets");
  await mkdir(assetsDir, { recursive: true });
  // The author MAP enumerates every post path → profile, so a private blog
  // must not serve it (one capability link would hand over every slug). The
  // byline reads its single post's profile from inline data injected into the
  // post's own HTML instead (strip-served-html → injectBylineData). Avatars
  // below are keyed by author HANDLE, not post path, so they're kept.
  if (!isPrivateBlog()) {
    await writeFile(join(assetsDir, "authors.json"), JSON.stringify(map), "utf8");
  }

  const avatarEntries = Object.entries(avatars);
  if (avatarEntries.length > 0) {
    const dst = join(assetsDir, "authors");
    await mkdir(dst, { recursive: true });
    for (const [servedName, srcPath] of avatarEntries) {
      await cp(srcPath, join(dst, servedName));
    }
  }
  return avatarEntries.length;
}

// Public per-post last-updated date served at /assets/post-versions.json. The
// client byline fetches this and renders the date; we deliberately publish only
// the most recent builtAt (no hash, no per-build history) so this stays a
// human-readable freshness signal, distinct from the gated /post-version
// endpoint. Dev produces the identical file from the same `posts/versions.json`.
async function copyPublicPostVersions(): Promise<number> {
  // Enumerates every post path → lastUpdated. Suppressed on a private blog
  // (the byline gets its date from inline per-post data); see copyAuthorAssets.
  if (isPrivateBlog()) return 0;
  const map = await buildPublicPostVersionsMap(paths.versionsJson);
  const assetsDir = join(DIST, "assets");
  await mkdir(assetsDir, { recursive: true });
  await writeFile(
    join(assetsDir, "post-versions.json"),
    JSON.stringify(map),
    "utf8",
  );
  return Object.keys(map).length;
}

// PWA bundle: SW source (engine), manifest + icons (content), and the engine
// policy header for /sw.js (Cache-Control: no-cache so a deploy rolls out).
// See methodology → Offline / PWA for the engine/content split rationale.
async function copyPwaFiles(): Promise<{ sw: boolean; manifest: boolean; icons: number }> {
  const out = { sw: false, manifest: false, icons: 0 };

  // Engine-owned: the SW source. Two copy-time rewrites (Bun's bundler doesn't
  // process sw.js — it's served as top-level /sw.js, outside the bundle graph):
  //   1. Splice the ONE shared RFC 7233 range resolver (shared/httpRange.ts,
  //      transpiled to plain JS) into the `__HTTP_RANGE__` block, so the SW
  //      doesn't carry a third hand-rolled parser that drifts from the dev
  //      server + Worker. See generate/swHttpRange.ts.
  //   2. Substitute __SW_VERSION__ so each deploy invalidates activate's reap.
  const swSrc = join(ENGINE, "client/sw.js");
  if (await exists(swSrc)) {
    const swText = await Bun.file(swSrc).text();
    const rangeSrc = await Bun.file(join(ENGINE, "shared/httpRange.ts")).text();
    const spliced = spliceHttpRangeIntoSw(swText, renderHttpRangeForSw(rangeSrc));
    const version = Date.now().toString();
    await writeFile(
      join(DIST, "sw.js"),
      spliced.replaceAll("__SW_VERSION__", version),
      "utf8",
    );
    out.sw = true;
  }

  // Content-owned: per-blog manifest. Missing → blog hasn't authored one yet;
  // the SW still works, the install prompt just won't fire on Chrome/Edge.
  const manifestSrc = join(ROOT, "manifest.webmanifest");
  if (await exists(manifestSrc)) {
    await cp(manifestSrc, join(DIST, "manifest.webmanifest"));
    out.manifest = true;
  }

  // Content-owned: per-blog icons.
  const iconsSrc = join(ROOT, "icons");
  if (await exists(iconsSrc)) {
    await mkdir(join(DIST, "icons"), { recursive: true });
    await cp(iconsSrc, join(DIST, "icons"), { recursive: true });
    out.icons = (await readdir(iconsSrc)).filter((n) => !n.startsWith(".")).length;
  }

  // Engine-owned policy: `Cache-Control: no-cache` on /sw.js. Append (not
  // overwrite) so a blog can add its own _headers rules later without losing
  // this one. Idempotent via the marker comment.
  if (out.sw) {
    await appendSwHeadersRule(join(DIST, "_headers"));
  }

  return out;
}

const SW_HEADERS_MARKER = "# presidocs: sw.js no-cache";
async function appendSwHeadersRule(headersPath: string): Promise<void> {
  let current = "";
  if (await exists(headersPath)) {
    current = await Bun.file(headersPath).text();
    if (current.includes(SW_HEADERS_MARKER)) return;
  }
  const sep = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  const block = `${sep}${SW_HEADERS_MARKER}\n/sw.js\n  Cache-Control: no-cache\n`;
  await writeFile(headersPath, current + block, "utf8");
}

async function main(): Promise<void> {
  console.log("Copying static assets into dist/…");
  if (!(await exists(DIST))) {
    console.warn(
      `  dist/ does not exist — run \`bun build\` first; skipping.`,
    );
    return;
  }
  const audioCount = await copyGeneratedArtifacts();
  console.log(`  generated/ → dist/generated/ (${audioCount} file(s))`);
  const wasmOk = await copyAutomergeWasm();
  if (wasmOk) console.log(`  automerge.wasm → dist/assets/automerge.wasm`);
  const fontCount = await copyFonts();
  console.log(`  client/fonts → dist/fonts/ (${fontCount} file(s), incl. OFL.txt)`);
  const avatarCount = await copyAuthorAssets();
  console.log(
    `  authors/ → dist/assets/authors.json + ${avatarCount} avatar(s)`,
  );
  const versionCount = await copyPublicPostVersions();
  console.log(
    `  posts/versions.json → dist/assets/post-versions.json (${versionCount} post(s))`,
  );
  const pwa = await copyPwaFiles();
  console.log(
    `  PWA: ${pwa.sw ? "sw.js + _headers" : "(no sw.js source)"}, ${
      pwa.manifest ? "manifest.webmanifest" : "(no manifest)"
    }, ${pwa.icons} icon(s)`,
  );
  // Backstop: fail legibly if anything in the final tree breaches Cloudflare's
  // 25 MiB per-asset cap, rather than letting Miniflare/wrangler throw an opaque
  // trace later.
  await assertNoOversizedAssets();
  console.log("Done.");
}

// Only run as a CLI; importing the pure helpers (e.g. shouldShipGeneratedFile
// from tests) must not trigger a copy.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
