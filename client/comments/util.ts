// methodology.md → Comments — small shared helpers used across the comment
// system's collaborator modules (motion-aware scroll behavior, id generation).

// Honour the OS "reduce motion" preference at the explicit-`smooth`
// scrollIntoView sites. An explicit `behavior` overrides the
// `html { scroll-behavior }` rule (and its reduce-motion override) in
// base.css, so each JS call needs its own guard. Read at call time so a
// mid-session OS toggle is respected; degrades to "smooth" where matchMedia
// is unavailable (test/SSR DOM).
export const scrollBehavior = (): ScrollBehavior =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
