---
name: post-authoring
description: The authoring rules for writing a post's HTML that methodology.md doesn't make obvious — id discipline, the markup invariants the build/Stop-hook gates hard-fail on, and what to regenerate before publishing. Use when creating or restructuring a post, or wiring in narration/figures. Examples - "scaffold a new post", "add a section or chapter", "why is the post audit failing", "what do I run before publishing".
user-invocable: true
---

# post-authoring

`methodology.md` is the system reference. This skill adds only the authoring rules that aren't obvious from them.

## Useful information

- `id` in HTML are often used to specify what content should be changed
- For animated figures, use the **figure-journey** skill
- To pull user feedback, use the **process-comments** skill
- Prefer adding visual information (ex: figures, tables) when possible
- When content requires deep technical knowledge outside of the post's target audience, prefer technical asides (using details/summary tags) or appendix (at the end of the blog post) for overly technical content
- Ensure narration is up-to-date with prose.
- Narration should have good coverage of the content, but aim to be more concise sentence structures (like giving a talk at an event)
- Figures don't show up in AI-focused markdowns of blog posts, so ensure the figcaption conveys the idea. Don't make the figcaption overly verbose though, as they are also visible to users reading the post (the figcaption goal should be in a sense to provide enough context to an LLM reading a markdown version of the blog post so that they can decide if they want to download the figure's code to inspect it in more detail)
- Code blocks can use Shiki (we use a few extensions to make it more powerful). Don't hesitate to combine code blocks with other visualizations inside the same figure (multi-modal figures is fine)
- Figures are generally made with gsap. Tables, svgs, and other formats can be acceptable, but generally should be wrapped in a figure so that they can be targeted by the comment system.
- generally only two tiers of hierarchies are supports
    - dividers with `section-divider-labeled` 
    - h2
- `scripts/post-checks.ts` / `generate/audit-posts.ts` can be used to run any linting rules after an edit (also runs automatically on `Stop` Claude hooks)
An `id` is how the engine binds a block to narration highlighting, deep/fragment links, comment anchors, and id-addressed edits ("change the element with this id"). So:
