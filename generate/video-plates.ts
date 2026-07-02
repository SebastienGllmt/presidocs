// satori chrome plates (chapter background + intro/divider slide) + the post
// metadata loader that feeds them, for the video export.
// See methodology.md → "Video export".

import { join } from "node:path";
import { existsSync } from "node:fs";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { resolveAuthorProfile } from "../shared/authorProfile.ts";
import { parseAuthorEmailFromHtml } from "../server/postMeta.ts";
import { extractPostMeta, readSiteMeta } from "./feeds.ts";
import { C } from "./video-constants.ts";
import type { ManifestChapter as Chapter } from "../shared/manifestSchema.ts";

const paths = resolveBlogPaths();

// =============================================================================
// satori chrome plates (background + chapter intro slide)
// =============================================================================

export type PostCtx = {
  siteName: string;
  title: string;
  authorName: string | null;
  avatarDataUri: string | null;
};

function speakerChip(ctx: PostCtx, size: number, fontSize: number): unknown {
  const children: unknown[] = [];
  if (ctx.avatarDataUri) {
    children.push({
      type: "img",
      props: {
        src: ctx.avatarDataUri,
        width: size,
        height: size,
        style: { width: size, height: size, borderRadius: size, objectFit: "cover" },
      },
    });
  }
  if (ctx.authorName) {
    children.push({
      type: "div",
      props: { style: { fontSize, fontWeight: 700, color: C.slate }, children: ctx.authorName },
    });
  }
  return { type: "div", props: { style: { display: "flex", alignItems: "center", gap: 16 }, children } };
}

export function bgPlate(ctx: PostCtx, chapter: Chapter, parentTitle: string | null): unknown {
  const pillChildren: unknown[] = [
    {
      type: "div",
      props: {
        style: { fontSize: 22, fontWeight: 700, letterSpacing: 3, textTransform: "uppercase", color: C.accent },
        children: "Chapter",
      },
    },
  ];
  if (parentTitle) {
    pillChildren.push({
      type: "div",
      props: { style: { fontSize: 26, color: C.muted }, children: parentTitle },
    });
  }
  pillChildren.push({
    type: "div",
    props: { style: { display: "flex", fontSize: 38, fontWeight: 700, lineHeight: 1.1, color: "#e6edf3" }, children: chapter.title },
  });

  return {
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: C.bg,
        padding: "70px 64px",
        fontFamily: "Red Hat Text",
      },
      children: [
        {
          type: "div",
          props: {
            style: { display: "flex", flexDirection: "column", gap: 16 },
            children: [
              {
                type: "div",
                props: {
                  style: { fontSize: 26, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", color: C.muted },
                  children: ctx.siteName,
                },
              },
              {
                type: "div",
                props: {
                  style: { display: "flex", fontSize: 50, fontWeight: 700, lineHeight: 1.12, color: C.fg, maxHeight: 50 * 1.12 * 3, overflow: "hidden" },
                  children: ctx.title,
                },
              },
              {
                type: "div",
                props: {
                  style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 8, paddingLeft: 18, borderLeft: `8px solid ${C.accent}` },
                  children: pillChildren,
                },
              },
              { type: "div", props: { style: { display: "flex", marginTop: 22 }, children: [speakerChip(ctx, 52, 30)] } },
            ],
          },
        },
      ],
    },
  };
}

// The OPENING slide only: a proper author intro — blog name, the opening
// chapter title, and the speaker (avatar + name). Shown once, at the start.
export function introPlate(ctx: PostCtx, chapter: Chapter): unknown {
  return {
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        backgroundColor: C.slideBg,
        padding: "0 90px",
        fontFamily: "Red Hat Text",
      },
      children: [
        { type: "div", props: { style: { width: 120, height: 12, backgroundColor: C.accent, marginBottom: 40 } } },
        {
          type: "div",
          props: {
            style: { fontSize: 30, fontWeight: 700, letterSpacing: 4, textTransform: "uppercase", color: C.muted, marginBottom: 16 },
            children: ctx.siteName,
          },
        },
        {
          type: "div",
          props: {
            style: { display: "flex", fontSize: 84, fontWeight: 700, lineHeight: 1.08, color: C.fg, maxHeight: 84 * 1.08 * 4, overflow: "hidden" },
            children: chapter.title,
          },
        },
        { type: "div", props: { style: { display: "flex", marginTop: 48 }, children: [speakerChip(ctx, 56, 30)] } },
      ],
    },
  };
}

// Every chapter break AFTER the opening: a slideshow section divider — accent
// bar + (parent-section label when this is a sub-chapter) + the chapter title.
// Deliberately NO author/blog chrome (the persistent header carries that).
export function slidePlate(_ctx: PostCtx, chapter: Chapter, parentTitle: string | null): unknown {
  // A section divider, slideshow-style: accent bar + (parent-section label when
  // this is a sub-chapter) + the chapter title. Deliberately NO author/blog/
  // title chrome — the persistent background plate carries that continuously, so
  // re-showing it on every chapter break would be noise.
  const children: unknown[] = [
    { type: "div", props: { style: { width: 120, height: 12, backgroundColor: C.accent, marginBottom: 40 } } },
  ];
  if (parentTitle) {
    children.push({
      type: "div",
      props: {
        style: { fontSize: 30, fontWeight: 700, letterSpacing: 4, textTransform: "uppercase", color: C.muted, marginBottom: 16 },
        children: parentTitle,
      },
    });
  }
  children.push({
    type: "div",
    props: {
      style: { display: "flex", fontSize: 84, fontWeight: 700, lineHeight: 1.08, color: C.fg, maxHeight: 84 * 1.08 * 4, overflow: "hidden" },
      children: chapter.title,
    },
  });
  return {
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        backgroundColor: C.slideBg,
        padding: "0 90px",
        fontFamily: "Red Hat Text",
      },
      children,
    },
  };
}

// --- post metadata helpers ---------------------------------------------------

// Post <title> and blog name: one source of truth with the feed extractors in
// generate/feeds.ts (HTMLRewriter + entity decode; a real parser handles tag
// attributes, RCDATA, and entity boundaries a regex would miss).
function extractTitle(html: string): string {
  return extractPostMeta(html).title;
}

async function readSiteName(): Promise<string> {
  return (await readSiteMeta()).title;
}

async function avatarDataUri(srcPath: string | null): Promise<string | null> {
  if (!srcPath || !existsSync(srcPath)) return null;
  const ext = srcPath.split(".").pop()?.toLowerCase();
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "png" ? "image/png" : null;
  if (!mime) return null;
  const b64 = Buffer.from(await Bun.file(srcPath).arrayBuffer()).toString("base64");
  return `data:${mime};base64,${b64}`;
}

export async function loadPostCtx(slug: string): Promise<PostCtx> {
  const htmlPath = join(paths.postsDir, `${slug}.html`);
  const html = existsSync(htmlPath) ? await Bun.file(htmlPath).text() : "";
  const title = extractTitle(html) || slug;
  const siteName = (await readSiteName()) || "Blog";
  const email = html ? parseAuthorEmailFromHtml(html) : null;
  let authorName: string | null = null;
  let avatar: string | null = null;
  if (email) {
    const res = await resolveAuthorProfile(paths.contentRoot, email);
    if (res.ok) {
      authorName = res.author.profile.name;
      avatar = await avatarDataUri(res.author.avatarSrcPath);
    }
  }
  return { siteName, title, authorName, avatarDataUri: avatar };
}
