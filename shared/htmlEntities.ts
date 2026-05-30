// Decode HTML entities to real characters.
//
// `HTMLRewriter` hands text-node content back with HTML entities intact
// (`&mdash;`, `&#39;`, `&amp;`). When that text is then placed into a context
// that does its OWN escaping — an XML feed field, an HTML attribute, a JSON-LD
// string — the entity would be double-encoded (`&amp;mdash;`) and render
// literally. So callers that re-escape decode first with this, turning the
// entity back into the character it denotes; the destination's escaper then
// encodes only what that destination requires.
//
// Used by shared/injectStructuredData.ts (og:/JSON-LD plain-text fields) and
// generate/feeds.ts (Atom/RSS plain-text fields).

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", copy: "©",
  reg: "®", trade: "™", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", deg: "°", times: "×",
};

export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? m;
  });
}
