// Build step: render social share cards (the Open Graph / Twitter /
// Schema.org `image`) — 1200x630 PNGs showing the blog name, a title, and an
// author (avatar + name). One per post (written to `dist/assets/og/<slug>.png`)
// PLUS one landing-page site card (`dist/assets/og/_site.png`), used as the
// default share images by the structured-data inject unless a page declares
// its own `<meta property="og:image">`. This makes `og:image` (a REQUIRED
// Open Graph property) always present on both posts AND the landing page,
// and gives a real 1200x630 card instead of a tiny avatar thumbnail.
//
// Pipeline: satori lays the card out from a plain element tree (no JSX/React —
// the engine is React-free) into an SVG with text already converted to vector
// paths, then @resvg/resvg-wasm rasterizes that SVG to PNG. Deterministic, no
// native binary, no headless browser. Fonts (Inter) are vendored under
// generate/assets/fonts/ and embedded by satori at build time.
//
// Runs after `bun build` (needs dist/) and before strip-served-html.ts (which
// references the card URL when injecting og:image). Skipped, like the other
// discovery features, when SITE_URL is unset.

import satori from "satori";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { resolveAuthorProfile } from "../shared/authorProfile.ts";
import { parseAuthorEmailFromHtml } from "../server/postMeta.ts";
import { decodeHtmlEntities } from "../shared/htmlEntities.ts";
import { readSiteMeta } from "./feeds.ts";

const paths = resolveBlogPaths();

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

// --- font + wasm loading (once per process) ----------------------------------

let fontsCache: { name: string; data: ArrayBuffer; weight: 400 | 700; style: "normal" }[] | null = null;
async function loadFonts() {
  if (fontsCache) return fontsCache;
  // satori's font parser rejects variable fonts (it chokes on the `fvar`
  // table), so we vendor two STATIC weights. DejaVu Sans is freely
  // redistributable and ships the regular + bold instances we need; see
  // generate/assets/fonts/LICENSE.
  const dir = join(paths.engineRoot, "generate", "assets", "fonts");
  const [regular, bold] = await Promise.all([
    Bun.file(join(dir, "DejaVuSans.ttf")).arrayBuffer(),
    Bun.file(join(dir, "DejaVuSans-Bold.ttf")).arrayBuffer(),
  ]);
  fontsCache = [
    { name: "DejaVu Sans", data: regular, weight: 400, style: "normal" },
    { name: "DejaVu Sans", data: bold, weight: 700, style: "normal" },
  ];
  return fontsCache;
}

let wasmReady: Promise<void> | null = null;
function ensureResvg(): Promise<void> {
  // initWasm must be called exactly once per process; memoize.
  if (!wasmReady) {
    wasmReady = (async () => {
      let wasmPath: string;
      try {
        wasmPath = Bun.resolveSync("@resvg/resvg-wasm/index_bg.wasm", paths.engineRoot);
      } catch {
        wasmPath = join(paths.engineRoot, "node_modules", "@resvg", "resvg-wasm", "index_bg.wasm");
      }
      await initWasm(await Bun.file(wasmPath).arrayBuffer());
    })();
  }
  return wasmReady;
}

// --- card layout + render ----------------------------------------------------

export type ShareCardInput = {
  siteName: string;
  title: string;
  authorName: string | null;
  /** Base64 data URI for the avatar, or null. */
  avatarDataUri: string | null;
};

// satori takes a React-element-like tree; we hand-build plain objects so the
// engine needs no JSX/React. Every node that holds more than one child must set
// `display: flex` (satori is strict about this).
function cardElement(input: ShareCardInput) {
  const footerChildren: unknown[] = [];
  if (input.avatarDataUri) {
    footerChildren.push({
      type: "img",
      props: {
        src: input.avatarDataUri,
        width: 72,
        height: 72,
        style: { width: 72, height: 72, borderRadius: 72, objectFit: "cover" },
      },
    });
  }
  if (input.authorName) {
    footerChildren.push({
      type: "div",
      props: { style: { fontSize: 30, fontWeight: 700, color: "#1f2328" }, children: input.authorName },
    });
  }

  return {
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px 80px",
        backgroundColor: "#fafbfc",
        // a thick brand accent down the left edge
        borderLeft: "16px solid #1f6feb",
        fontFamily: "DejaVu Sans",
      },
      children: [
        // top: blog name
        {
          type: "div",
          props: {
            style: {
              fontSize: 30,
              fontWeight: 700,
              letterSpacing: 2,
              textTransform: "uppercase",
              color: "#57606a",
            },
            children: input.siteName,
          },
        },
        // middle: article title (satori wraps; clamp height via line clamp)
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              fontSize: 68,
              fontWeight: 700,
              lineHeight: 1.15,
              color: "#1f2328",
              // clamp to ~4 lines so a long title can't overflow the card
              maxHeight: 68 * 1.15 * 4,
              overflow: "hidden",
            },
            children: input.title,
          },
        },
        // bottom: author
        {
          type: "div",
          props: {
            style: { display: "flex", alignItems: "center", gap: 24 },
            children: footerChildren,
          },
        },
      ],
    },
  };
}

export async function renderShareCard(input: ShareCardInput): Promise<Uint8Array> {
  const fonts = await loadFonts();
  await ensureResvg();
  const svg = await satori(cardElement(input) as Parameters<typeof satori>[0], {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    fonts,
  });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: CARD_WIDTH } })
    .render()
    .asPng();
  return png;
}

// Generic satori→resvg renderer (same font/wasm path as the share card), so
// other build steps (e.g. generate/render-video.ts) can rasterize their own
// plain-object element trees without duplicating the font/wasm bootstrap.
export async function renderElementToPng(
  element: unknown,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const fonts = await loadFonts();
  await ensureResvg();
  const svg = await satori(element as Parameters<typeof satori>[0], { width, height, fonts });
  return new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
}

// --- build driver ------------------------------------------------------------

// The blog name from the landing index.html <title> (engine stays content-
// agnostic — never hardcodes a blog name). Mirrors generate/feeds.ts.
async function readSiteName(): Promise<string> {
  const indexPath = join(paths.contentRoot, "index.html");
  if (!existsSync(indexPath)) return "";
  const html = await Bun.file(indexPath).text();
  let title = "";
  let inTitle = false;
  new HTMLRewriter()
    .on("title", {
      element() {
        inTitle = true;
      },
      text(t) {
        if (inTitle) title += t.text;
        if (t.lastInTextNode) inTitle = false;
      },
    })
    .transform(html);
  return decodeHtmlEntities(title.replace(/\s+/g, " ").trim());
}

function extractTitle(html: string): string {
  let title = "";
  let inTitle = false;
  new HTMLRewriter()
    .on("title", {
      element() {
        inTitle = true;
      },
      text(t) {
        if (inTitle) title += t.text;
        if (t.lastInTextNode) inTitle = false;
      },
    })
    .transform(html);
  return decodeHtmlEntities(title.replace(/\s+/g, " ").trim());
}

function hasOwnOgImage(html: string): boolean {
  return /<meta\s+[^>]*property=["']og:image["']/i.test(html);
}

export async function avatarDataUri(srcPath: string | null): Promise<string | null> {
  if (!srcPath) return null;
  // satori reliably embeds PNG/JPEG only — it can't decode WebP (throws on the
  // missing dimensions). The engine prefers WebP for browser delivery, so the
  // resolved avatar is often `.webp`; fall back to a same-name PNG/JPEG sibling
  // the author keeps for exactly this. No raster sibling ⇒ the card renders
  // without a photo (degrade, don't fail).
  let path = srcPath;
  let ext = path.split(".").pop()?.toLowerCase();
  if (ext !== "png" && ext !== "jpg" && ext !== "jpeg") {
    const base = srcPath.slice(0, srcPath.length - (ext?.length ?? 0) - 1); // strip ".<ext>"
    const sibling = ["png", "jpg", "jpeg"].map((e) => `${base}.${e}`).find((p) => existsSync(p));
    if (!sibling) return null;
    path = sibling;
    ext = path.split(".").pop()?.toLowerCase();
  }
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
  const b64 = Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64");
  return `data:${mime};base64,${b64}`;
}

async function main(): Promise<void> {
  const siteUrl = (process.env.SITE_URL ?? "").trim();
  if (!siteUrl) {
    console.log("Share cards: no SITE_URL — skipping.");
    return;
  }
  if (!existsSync(paths.distDir)) {
    console.warn("  dist/ does not exist — run `bun build` first; skipping share cards.");
    return;
  }
  const siteName = (await readSiteName()) || "Blog";
  const outDir = join(paths.distDir, "assets", "og");
  await mkdir(outDir, { recursive: true });

  // versions.json lets us pick the newest-post author for the SITE card (same
  // convention strip-served-html.ts:pickSiteAuthor and feeds.ts's channel
  // author derivation use — one rule across all three call sites). Missing
  // file just means no site-author block on the site card.
  type VersionEntry = { builtAt: string };
  let versions: Record<string, VersionEntry[]> = {};
  try {
    versions = (await Bun.file(paths.versionsJson).json()) as Record<string, VersionEntry[]>;
  } catch {
    versions = {};
  }

  const postFiles = (await readdir(paths.postsDir)).filter((f) => f.endsWith(".html"));
  let made = 0;
  let skipped = 0;
  let newestPostBuiltAt = "";
  let siteAuthorEmail: string | null = null;
  for (const file of postFiles) {
    const slug = file.replace(/\.html$/, "");
    const html = await Bun.file(join(paths.postsDir, file)).text();
    const email = parseAuthorEmailFromHtml(html);
    if (!email) continue; // not a real post
    // Track newest-post author for the site card, regardless of per-post
    // og:image override (the override only suppresses THIS post's card).
    const builtAt = versions[`/posts/${slug}`]?.[0]?.builtAt;
    if (builtAt && builtAt > newestPostBuiltAt) {
      newestPostBuiltAt = builtAt;
      siteAuthorEmail = email;
    }
    if (hasOwnOgImage(html)) {
      skipped++;
      continue; // post supplies its own image — no generated card needed
    }
    const title = extractTitle(html) || slug;
    const res = await resolveAuthorProfile(paths.contentRoot, email);
    const authorName = res.ok ? res.author.profile.name : null;
    const avatar = await avatarDataUri(res.ok ? res.author.avatarSrcPath : null);

    const png = await renderShareCard({ siteName, title, authorName, avatarDataUri: avatar });
    await writeFile(join(outDir, `${slug}.png`), png);
    made++;
    console.log(`  card → assets/og/${slug}.png`);
  }

  // Landing-page card (`_site.png`): the leading `_` keeps it out of the post
  // slug space (post filenames are alphanumeric/hyphen, never leading `_`).
  // Skipped when the landing declares its own og:image — same convention as
  // per-post cards. Skipped when the landing has no description for the middle
  // band (the brand-only card would be visually empty).
  const landingPath = join(paths.contentRoot, "index.html");
  const landingHtml = existsSync(landingPath) ? await Bun.file(landingPath).text() : "";
  let siteCardMade = false;
  if (landingHtml && !hasOwnOgImage(landingHtml)) {
    const meta = await readSiteMeta();
    if (meta.description) {
      const siteAuthorRes = siteAuthorEmail
        ? await resolveAuthorProfile(paths.contentRoot, siteAuthorEmail)
        : null;
      const siteAuthorName =
        siteAuthorRes && siteAuthorRes.ok ? siteAuthorRes.author.profile.name : null;
      const siteAvatar = await avatarDataUri(
        siteAuthorRes && siteAuthorRes.ok ? siteAuthorRes.author.avatarSrcPath : null,
      );
      // The middle band gets the site DESCRIPTION (tagline), not the site
      // name — the brand position (top) already carries the name, so putting
      // the same text in both would just duplicate. The tagline is the
      // discriminating content for a "this is the blog" card.
      const png = await renderShareCard({
        siteName: meta.title || siteName,
        title: meta.description,
        authorName: siteAuthorName,
        avatarDataUri: siteAvatar,
      });
      await writeFile(join(outDir, "_site.png"), png);
      siteCardMade = true;
      console.log(`  card → assets/og/_site.png (landing card)`);
    }
  }

  console.log(
    `Share cards: ${made} post card${made === 1 ? "" : "s"} generated` +
      (skipped ? `, ${skipped} skipped (own og:image)` : "") +
      (siteCardMade ? "; landing card generated" : "; no landing card"),
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
