// Validate `data-chapter-parent` pointers and enforce the two-level cap.
//
// Degrades to a flat chapter rather than hard-failing — matching the
// opt-out philosophy of never erroring a whole batch generate over one
// bad post. Mutates each `parentId` in place. Document order IS array
// order, so a valid parent always sits at a LOWER index than its child;
// pre-condition violators degrade with a warn.
//
// Extracted from generate.ts as a Tier-0 pure carve-out so it can be
// exhaustively tested without standing up the HTMLRewriter pipeline. The
// optional `warn` callback exists only for the tests — production callers
// let it default to `console.warn` exactly as before.

export type ChapterParentInput = {
  id: string;
  parentId?: string | undefined;
};

export function normalizeChapterParents<T extends ChapterParentInput>(
  list: T[],
  warn: (msg: string) => void = console.warn,
): void {
  const indexById = new Map<string, number>();
  list.forEach((c, i) => indexById.set(c.id, i));
  list.forEach((c, i) => {
    if (c.parentId === undefined) return;
    const pIdx = indexById.get(c.parentId);
    if (pIdx === undefined || pIdx >= i) {
      warn(
        `Chapter "${c.id}": data-chapter-parent="${c.parentId}" does not name an ` +
          `earlier chapter; treating "${c.id}" as a top-level chapter.`,
      );
      c.parentId = undefined;
      return;
    }
    // The parent was already normalized (it sits at a lower index, processed
    // first). If it still has a parent, it's a level-2 chapter and `c` would be
    // a third level — collapse `c` up to its grandparent to keep the cap at two.
    const parent = list[pIdx]!;
    if (parent.parentId !== undefined) {
      warn(
        `Chapter "${c.id}": parent "${c.parentId}" is itself a sub-chapter; ` +
          `flattening to grandparent "${parent.parentId}" (two-level cap).`,
      );
      c.parentId = parent.parentId;
    }
  });
}
