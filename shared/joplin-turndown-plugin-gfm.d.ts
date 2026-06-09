// Minimal types for `@joplin/turndown-plugin-gfm` (1.0.x ships no `.d.ts`, and
// there is no `@types/...` package for the Joplin fork). Each export is a
// Turndown plugin — a function passed to `TurndownService.use()`. Declared here
// following the same untyped-dep convention as `shared/content-disposition.d.ts`
// / `client/shikwasa.d.ts`. Build-time only; never reaches the browser bundle.
declare module "@joplin/turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  /** A Turndown plugin: registers rules on the service it's given. */
  type GfmPlugin = (service: TurndownService) => void;
  /** All three rules at once (tables + strikethrough + task-list items). */
  export const gfm: GfmPlugin;
  /** GFM pipe tables. */
  export const tables: GfmPlugin;
  /** `~~struck~~` from `<del>` / `<s>`. */
  export const strikethrough: GfmPlugin;
  /** `- [ ]` / `- [x]` from `<input type=checkbox>` list items. */
  export const taskListItems: GfmPlugin;
}
