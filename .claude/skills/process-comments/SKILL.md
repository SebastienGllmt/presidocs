---
name: process-comments
description: Apply unresolved reader/author comments to a blog post in this repo, editing the post HTML in place and resolving the comments that get addressed. Use when the author wants to work through the open comments on a post and roll them into the next draft. Examples - "/process-comments hash-functions", "process the comments on the hash-functions post", "apply the open feedback to <slug>".
user-invocable: true
---

# process-comments

Work through the open comments on a single blog post and apply them to the post's HTML, editing it **in place** during this interactive session. The author reviews each change live (`git diff`), can steer mid-pass, and you iterate with them across passes until they're satisfied — then you resolve the comments that got addressed.

See `engine/methodology.md` → "AI-assisted authoring" for the full flow and rationale, and "Anchoring: the Web Annotation target model" for the shape of the comment data.

## Inputs

The user gives a post **slug** (the stem under `posts/`, e.g. `hash-functions`). If they didn't, ask which post — or infer it if exactly one post has open comments.

## Flow

1. **Pull the comments** into the local store first, so you work against what was actually left:

   ```bash
   bun run pull-comments <slug>            # production comments (readers)
   bun run pull-comments <slug> --local    # comments left on the LOCALHOST dev server
   ```

   The production pull briefly runs a bucket-bound Worker via `wrangler dev --remote` using the author's existing wrangler login (no extra credential to set up), mirrors R2 → `generated/.comments-dev/`, then tears down. It's additive, scoped to this slug, and a harmless no-op for a post with no production comments yet. (If it errors, the author may not be logged in — `wrangler whoami`; report and ask rather than guessing.)

   Comments left through a **running localhost dev server** live in its own store (Miniflare R2), not in `generated/.comments-dev/` — the `--local` pull mirrors them down over the dev server's HTTP API. See `engine/methodology.md` → "Syncing production comments".

   **Decision rule: run both pulls.** Both are additive into the same local store, so running both is always safe, and you can't tell from the outside which store holds comments. The `--local` pull fails fast with "no dev server reachable" when none is running — that means "nothing to pull from localhost", so note it and move on (don't debug it, don't ask). The production pull likewise no-ops for an unpublished post.

   Related (not part of this flow): `bun run seed-comments <slug>` copies the pulled production comments INTO the running dev server so they render in the author's localhost browser (where they get a `production` origin tag, and the author can reply locally with context for you). Run it only if the author asks to see prod comments on localhost — it changes their browser view, not your working set.

2. **Fetch the open comments** as a Web Annotation collection:

   ```bash
   bun run export-annotations <slug>
   ```

   Each item is an `Annotation` with:
   - `id` — `urn:blog:<slug>:thread:<threadId>`. Track this; it's the key you'll resolve by.
   - `target` — a selector pinpointing the comment's anchor. `target.selector` holds a `RangeSelector` (which block, via `FragmentSelector`/`CssSelector`) and a `TextQuoteSelector` whose `exact` is the verbatim quoted text. `target.source` ending in `#narration` means the comment is on the spoken-script drawer, not the article body. `x-blog:segmentHashes` lists the touched block ids.
   - `body` — the reply thread (`TextualBody[]`), the actual feedback to act on.
   - `motivation` — usually `"commenting"`. `"editing"` marks a **suggestion** (propose-an-edit): the first body is a `TextualBody` with `purpose: "editing"` / `format: "text/plain"` whose `value` is the proposed replacement for the anchored `exact` text (empty `value` = delete the range). Apply it near-verbatim (at most fix typos. Do NOT change style or wording). The proposed text may carry literal `<em>…</em>` / `<strong>…</strong>` markup (the in-place editor is WYSIWYG); apply those as real HTML tags in the source, not as escaped text. Any `commenting` bodies after it are notes explaining the intent.
   - `x-blog:origin` (on the annotation and on each body) — which live store the thread/reply was born in. **Use this to read intent:** a `localhost` reply on a `production` thread is the author's scaffolding, left to give *you* extra context about the reader's feedback — it is never published to prod (the author follows up with commenters by email; never treat such a reply as something to answer). Origins also help debugging (e.g. "why doesn't this thread show on prod?"). `unknown` = pre-provenance data; treat as ordinary feedback.

   If the collection is empty (`total: 0`), tell the user there's nothing to process and stop.

3. **Read the editing rules** in `engine/authoring/authoringRules.md` and follow them exactly. They cover the post's HTML structure, the narration `<mark>` ↔ `id` pairing you must not break, which infra tags never to touch, and the apply/partial/note decision tree. Then **read `posts/<slug>.html`**.

4. **Edit `posts/<slug>.html` in place** — edit the file directly; `git diff` is the author's review surface. Use the `exact` quote and block ids from each annotation's `target` to locate text precisely. Make one focused Edit per change. Keep article ↔ narration in sync per the rules.

5. **Report a verdict per annotation**, in the exact form from the rules so the author can scan it:

   ```
   Thread #N (id=<threadId>): APPLIED | PARTIAL | NOTE-ONLY
     what changed, or what you flagged for the author to handle.
   ```

   Then **pause for the author**. This is the whole point of running in-session: let them review the diff (`git diff posts/<slug>.html`), ask for adjustments, or request another pass. Iterate with them until they're satisfied.

6. **Resolve the addressed threads** — only once the author confirms they're happy with the edits. Resolve only the threads you marked **APPLIED** (leave `PARTIAL` / `NOTE-ONLY` open for manual follow-up):

   ```bash
   bun run resolve-threads <slug> <threadId> [<threadId> ...]
   ```

   You can pass either the bare `<threadId>` or the full annotation `id` IRI — the tool accepts both. This writes author-resolution envelopes into the local dev comments store. Then **push them to production**:

   ```bash
   bun run push-resolutions <slug>
   ```

   Same `wrangler dev --remote` mechanism as the pull (fenced to resolution keys), so prod hides the resolved threads for the original commenters. `bun run push-resolutions <slug> --local` pushes to the **running dev server** instead, where the author's open browser tab hides them on its next poll — no restart needed.

   **Decision rule: push to each store whose pull found comments.** Each pull printed `Pulled N comment change-object(s) …` — a store that reported 0 holds no thread for this post, so skip its push (likewise skip `--local` if no dev server was running). Push to every store that reported >0: the merged local store doesn't record which individual thread came from which store, and a resolution envelope for a thread a store doesn't know is a harmless orphan (opaque threadId, opaque body), so over-pushing is safe — only *skipping* a store that has comments can leave a thread visible to its commenter.

7. **Remind the author of the follow-up steps** (don't run these yourself unless asked):

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
