# my-private-blog

A **private** blog on the shared **presidocs** engine: posts are reachable
only by people who were *given* the link. The URL is the secret — every post
filename ends in an unguessable `--<token>` suffix, and the engine's whole
discovery surface (sitemap, feeds, llms.txt, landing post list, Ask-this-blog,
publish webhooks) is suppressed and **audited on every build**
(`engine/generate/audit-private.ts`). Search engines are told `noindex` on
every response. Full design: engine `methodology.md` → **Private blogs**
(threat model included — read it before trusting this with anything serious;
notably, anyone holding a link can reshare it, and chat unfurlers may cache
previews).

This template mirrors `templates/content-repo` (same setup: `bun link` the
engine, `bun install`, `ln -sfn ../presidocs engine`, copy `.env.example` →
`.env`). The deltas that make it private:

- `BLOG_PRIVATE=1` in `.env` — the one knob everything keys on.
- `bun run new-post <slug>` — scaffolds `posts/<slug>--<token>.html` with a
  fresh 96-bit token. Never hand-invent tokens; the audit rejects filenames
  without one. **Renaming a file rotates its key** (leak recovery: rename,
  rebuild, redeploy — the old link 404s).
- **Re-mint the starter post before using it for anything real**: its token
  is committed in the public engine repo, so it's a known value, not a
  secret. Delete it or rename it with a fresh token.
- `index.html` — the one guessable URL. It explains how the blog works and
  must never link into `/posts/` (the audit enforces this).
- `deploy` runs no announce steps (no publish webhooks, no WebSub) and the
  audit fails the build if those env vars are even set.
- **Keep this repo private on GitHub** — the whole point of blog-level privacy
  is that source, figures, and generated audio are covered by one repo ACL.

Everything else — comments, narration (`bun run generate`), version history,
offline reading, share cards — works exactly as on a public presidocs blog;
those surfaces all live under the post's own URL, so they inherit its secrecy.
