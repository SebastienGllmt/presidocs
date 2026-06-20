// Escape a string for safe interpolation into build-emitted HTML, in the two
// contexts the head/footer injectors need: element text content and
// double-quoted attribute values. Consolidates the per-injector copies that had
// drifted across shared/ (injectFooter, injectPwaHead, injectStructuredData,
// injectAiSearch, bunHtmlHeadPlugin) into one pair.
//
// `&` is replaced FIRST so the `&` introduced by the later replacements isn't
// re-encoded — every former copy relied on this ordering.
//
// Dependency-free on purpose. `entities` (already a dep, used on the DECODE side
// in htmlEntities.ts) also ships `escapeText`/`escapeAttribute`, but their output
// differs — they omit `<`/`>` in attribute values and encode U+00A0 as `&nbsp;` —
// so reusing them would change every injector's emitted bytes. We keep the
// existing byte-for-byte behavior here; a bare-string escaper has no need of a
// dep, and staying dep-free also keeps it safe to reuse from worker-reachable
// code (where `entities`/`linkedom` must never be imported).
export function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeHtmlAttr(s: string): string {
  return escapeHtmlText(s).replace(/"/g, "&quot;");
}
