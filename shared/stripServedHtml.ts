// Pure HTML strip applied to the dist/ output as the final build step.
// Removes three kinds of tags that are present in source HTML for
// authoring + generation but have no role at the reader's runtime:
//
//   - <meta name="author-email" content="..."> — spam mitigation;
//     server-side author lookup reads the source HTML (via
//     server/postMeta.ts), not the served HTML, so dropping it here
//     doesn't break the auth check.
//   - <script type="text/narration">...</script> — narration script
//     blocks consumed only by the offline TTS generator. The runtime
//     player loads pre-rendered audio from the manifest, not the
//     inline script. Often several KB per post.
//   - <script type="application/pls+xml">...</script> — PLS lexicons,
//     same story: TTS-only, unused at runtime.
//
// Implementation: Bun's built-in `HTMLRewriter` (the Cloudflare port).
// Streaming parser, no dependencies, handles attribute-order /
// quote-style / multiline-body variations correctly because it's a
// real HTML parser rather than a regex. The same API works on
// Cloudflare Workers if we ever want to do the strip there too.

export function stripServedHtml(html: string): string {
  const rewriter = new HTMLRewriter()
    .on('meta[name="author-email"]', {
      element(el) {
        el.remove();
      },
    })
    .on('script[type="text/narration"]', {
      element(el) {
        el.remove();
      },
    })
    .on('script[type="application/pls+xml"]', {
      element(el) {
        el.remove();
      },
    });
  return rewriter.transform(html);
}
