// Reserve the space the client-side article chrome will occupy, so it never
// reflows the page when it mounts after parse / a fetch. Applied by
// `bunHtmlHeadPlugin` — which runs in BOTH dev (Bun's `[serve.static]` plugin,
// see createDevServer.ts) and prod (build-html's `Bun.build`) — so dev and prod
// behave identically. (It rides this plugin rather than the prod-only served-HTML
// strip precisely so the dev server reserves too; the strip would stabilize prod
// alone.)
//
// The chrome is rendered client-side for dev/prod parity (see client/byline.ts);
// these placeholders are the matching build-time half. Each carries the SAME box
// as its real counterpart (base.css `.back-link`/`.byline`/`.post-meta` ↔ the
// `*-reserve` classes; the control row's `.subctl-zone` is a min-height flex
// container the controls mount INTO), so the client's in-place `replaceWith` /
// append costs zero layout shift. The narration dock is shipped hidden so its
// empty box never paints; narrator.ts reveals it once mounted.

// Reserve placeholders where the client injects top-of-article chrome
// (client/backLink.ts → installBackLink, client/copyMarkdown.ts +
// client/subscribe.ts → the control row, client/byline.ts → mountBylineInto).
// Without this, the back-link prepended above the <h1> drops the title + "Last
// updated" strip + body; the copy-markdown + subscribe row dropped the body; and
// the fetched byline dropped it again — the `cls-culprits-insight` shifts.
//
// Post-scoped (the /posts/ gate). Placement mirrors the client mounts: back-link
// is the article's first child (above #title); after #lede (else #title) come the
// control zone then the byline; post-meta goes after #title. `reserveBackLink` /
// `reserveControls` are always set for posts (back-link + copy-markdown are
// unconditional); `reserveByline` only when the post has an author profile (else
// boot() bails); `reservePostMeta` only when the post has a version (else
// buildPostMeta returns null). Idempotent on the reserve marker classes.
export function injectArticleChromeReserve(
  html: string,
  postPath: string,
  opts: {
    reserveBackLink: boolean;
    reserveControls: boolean;
    reserveByline: boolean;
    reservePostMeta: boolean;
  },
): string {
  if (!postPath.startsWith("/posts/")) return html;
  if (!opts.reserveBackLink && !opts.reserveControls && !opts.reserveByline && !opts.reservePostMeta) {
    return html;
  }
  if (
    html.includes('class="back-link-reserve"') ||
    html.includes('class="subctl-zone"') ||
    html.includes('class="byline-reserve"') ||
    html.includes('class="post-meta-reserve"')
  ) {
    return html;
  }

  const backLinkHtml = opts.reserveBackLink
    ? `<div class="back-link-reserve" aria-hidden="true"></div>`
    : "";
  // The control row is a container the controls append INTO (not replace), so it
  // is the real `.subctl-zone` from the start — empty (AT-invisible) until copy-
  // markdown / subscribe fill it; base.css holds its one-row min-height.
  const controlsHtml = opts.reserveControls ? `<div class="subctl-zone"></div>` : "";
  const bylineHtml = opts.reserveByline
    ? `<div class="byline-reserve" aria-hidden="true"></div>`
    : "";
  const postMetaHtml = opts.reservePostMeta
    ? `<div class="post-meta-reserve" aria-hidden="true"></div>`
    : "";
  const hasLede = html.includes('id="lede"');
  const hasTitle = html.includes('id="title"');

  const rw = new HTMLRewriter();
  if (hasLede || hasTitle) {
    // Back-link is always the article's first child, above the <h1>.
    if (backLinkHtml) rw.on("article", { element(el) { el.prepend(backLinkHtml, { html: true }); } });
    if (hasLede) {
      // After the lede, in visual order: control zone → byline.
      const after = controlsHtml + bylineHtml;
      if (after) rw.on("#lede", { element(el) { el.after(after, { html: true }); } });
      if (postMetaHtml && hasTitle) {
        rw.on("#title", { element(el) { el.after(postMetaHtml, { html: true }); } });
      }
    } else {
      // #title, no lede: post-meta → control zone → byline, all after the title.
      const after = postMetaHtml + controlsHtml + bylineHtml;
      if (after) rw.on("#title", { element(el) { el.after(after, { html: true }); } });
    }
  } else {
    // Degenerate post (no title, no lede): prepend everything as the article's
    // first children, in visual order back-link → post-meta → controls → byline.
    const all = backLinkHtml + postMetaHtml + controlsHtml + bylineHtml;
    if (all) rw.on("article", { element(el) { el.prepend(all, { html: true }); } });
  }
  return rw.transform(html);
}

// Ship the narration dock hidden so its empty box never paints. The dock is
// `position: fixed`, so it never reflows the article — but as Shikwasa fills its
// empty player container after the manifest loads, the bottom-anchored dock
// grows upward, a self-shift Lighthouse attributes to `.narrate-dock`. Starting
// it in the existing `[data-hidden="true"]` state (off-screen via transform +
// opacity) means the build happens invisibly; narrator.ts reveals it
// (`revealDock`) once mounted — a transform/opacity transition, which never
// triggers layout shift. So the player costs zero CLS. The dock is a JS-only
// feature (empty containers a script populates), so hiding it until JS runs is
// correct progressive enhancement; an opt-out post's dock is hidden anyway
// (boot() sets display:none). Post-scoped; idempotent (skips an existing
// data-hidden).
export function hideNarrateDockForReveal(html: string, postPath: string): string {
  if (!postPath.startsWith("/posts/")) return html;
  return new HTMLRewriter()
    .on(".narrate-dock", {
      element(el) {
        if (el.hasAttribute("data-hidden")) return;
        el.setAttribute("data-hidden", "true");
        el.setAttribute("aria-hidden", "true");
      },
    })
    .transform(html);
}

// Apply the full post-chrome treatment in one call: hide the dock + reserve the
// back-link / control-row / byline / post-meta boxes. `hasAuthor` / `hasVersion`
// gate the data-dependent reserves to match what the client actually renders
// (the same `buildAuthorMap` / post-versions source the byline fetches). No-op
// for non-posts. The caller is `bunHtmlHeadPlugin` (dev + prod).
export function injectPostChrome(
  html: string,
  postPath: string,
  opts: { hasAuthor: boolean; hasVersion: boolean },
): string {
  html = hideNarrateDockForReveal(html, postPath);
  html = injectArticleChromeReserve(html, postPath, {
    reserveBackLink: true,
    reserveControls: true,
    reserveByline: opts.hasAuthor,
    reservePostMeta: opts.hasVersion,
  });
  return html;
}
