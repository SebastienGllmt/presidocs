---
name: process-comments
description: Apply unresolved reader/author comments to a blog post in this repo, editing the post HTML in place and resolving the comments that get addressed. Use when the author wants to work through the open comments on a post and roll them into the next draft. Examples - "/process-comments hash-functions", "process the comments on the hash-functions post", "apply the open feedback to <slug>".
user-invocable: true
---

# process-comments

Work through the open comments on a single blog post and apply them to the post's HTML, editing it **in place** during this interactive session. The author reviews each change live (`git diff`), can steer mid-pass, and you iterate with them across passes until they're satisfied — then you resolve the comments that got addressed.

See `methodology.md` → "AI-assisted authoring" for the full flow and rationale, and "Anchoring: the Web Annotation target model" for the shape of the comment data.

## Inputs

The user gives a post **slug** (the stem under `posts/`, e.g. `hash-functions`). If they didn't, ask which post — or infer it if exactly one post has open comments.

## Flow

1. **Fetch the open comments** as a Web Annotation collection:

   ```bash
   bun authoring/exportAnnotations.ts <slug>
   ```

   Each item is an `Annotation` with:
   - `id` — `urn:blog:<slug>:thread:<threadId>`. Track this; it's the key you'll resolve by.
   - `target` — a selector pinpointing the comment's anchor. `target.selector` holds a `RangeSelector` (which block, via `FragmentSelector`/`CssSelector`) and a `TextQuoteSelector` whose `exact` is the verbatim quoted text. `target.source` ending in `#narration` means the comment is on the spoken-script drawer, not the article body. `x-blog:segmentHashes` lists the touched block ids.
   - `body` — the reply thread (`TextualBody[]`), the actual feedback to act on.

   If the collection is empty (`total: 0`), tell the user there's nothing to process and stop.

2. **Read the editing rules** in `authoring/authoringRules.md` and follow them exactly. They cover the post's HTML structure, the narration `<mark>` ↔ `id` pairing you must not break, which infra tags never to touch, and the apply/partial/note decision tree. Then **read `posts/<slug>.html`**.

3. **Edit `posts/<slug>.html` in place** — edit the file directly; `git diff` is the author's review surface. Use the `exact` quote and block ids from each annotation's `target` to locate text precisely. Make one focused Edit per change. Keep article ↔ narration in sync per the rules.

4. **Report a verdict per annotation**, in the exact form from the rules so the author can scan it:

   ```
   Thread #N (id=<threadId>): APPLIED | PARTIAL | NOTE-ONLY
     what changed, or what you flagged for the author to handle.
   ```

   Then **pause for the author**. This is the whole point of running in-session: let them review the diff (`git diff posts/<slug>.html`), ask for adjustments, or request another pass. Iterate with them until they're satisfied.

5. **Resolve the addressed threads** — only once the author confirms they're happy with the edits. Resolve only the threads you marked **APPLIED** (leave `PARTIAL` / `NOTE-ONLY` open for manual follow-up):

   ```bash
   bun authoring/resolveThreads.ts <slug> <threadId> [<threadId> ...]
   ```

   You can pass either the bare `<threadId>` or the full annotation `id` IRI — the tool accepts both. This writes author-resolution envelopes into the local dev comments store; the author pushes them to R2 on their next deploy.

6. **Remind the author of the follow-up steps** (don't run these yourself unless asked):

   ```bash
   # Re-synthesize the narration for this post. The per-segment audio cache
   # means ONLY the sentences whose text you changed are re-rendered — every
   # unchanged segment is an instant cache hit — so this is cheap, no matter
   # how long the post is. Pick the render that matches what they want:
   bun run generate posts/<slug>.html        # quick draft render (fast — for listening back while iterating)
   bun run generate:prod posts/<slug>.html   # production render (higher quality, slower)

   # Then ship it:
   bun run build && wrangler deploy
   ```

   Notes:
   - The two `generate` scripts differ only in which audio engine they use (configured in `package.json`); you don't choose or name the engine here — just the script. `generate` is the fast iteration render; `generate:prod` is the production one.
   - You normally don't need to re-render the *whole* post or clear any cache — editing a sentence invalidates exactly that segment. (A pronunciation fix to the shared `posts/common-terms.pls` is the one exception, but that file is outside this skill's edit scope; leave it to the author.)
   - The build step records the new post version hash (so readers get the "doc updated" banner); you don't need a separate version bump.

## Guardrails

- **Edit only `posts/<slug>.html`.** Never touch other posts, `client/`, `server/`, the generated dirs, or infra tags listed in the rules.
- **Resolve only after author sign-off, and only APPLIED threads.** Resolution means "this feedback shipped" — don't resolve something the author hasn't accepted, and don't resolve PARTIAL/NOTE-ONLY.
- **Don't fabricate thread ids.** Only resolve ids that appeared in the exported collection.
