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
//
// Backed by `entities` (BSD-2-Clause, build-time only): `decodeHTMLStrict`
// decodes the full ~2,100-entity WHATWG named set plus all numeric refs,
// replacing an 18-entry hand-rolled table that silently passed everything else
// through un-decoded (so `&eacute;`/`&euro;`/`&frac12;`/arrows/Greek then got
// double-escaped by the destination). STRICT is deliberate: it requires the
// terminating `;`, so `&notareal;` and `&not` (no semicolon) stay literal —
// matching this module's original contract. `decodeHTML` (non-strict) would
// apply the WHATWG legacy longest-prefix rule (`&notareal;` → `¬areal;`) and
// corrupt prose mid-word. Note `&nbsp;` now decodes to U+00A0 (the spec
// non-breaking space the author typed), not U+0020.

import { decodeHTMLStrict } from "entities";

export function decodeHtmlEntities(s: string): string {
  return decodeHTMLStrict(s);
}
