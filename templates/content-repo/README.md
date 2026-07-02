# my-blog

A blog built on the shared **presidocs** blog engine, kept in its own
repository. The engine (narration player, comment system, build/TTS pipeline)
lives in the sibling `../presidocs` checkout and is linked in via `bun link`
(`"presidocs": "link:presidocs"`), so `node_modules/presidocs` is a single
symlink to that checkout — engine edits are picked up live, with no per-file
copy or symlink "farm" to go stale. This repo holds only content. The starter
ships with **no posts** — `bun run new-post <slug>` scaffolds your first one;
the pieces below appear as you author:

- `posts/*.html` — one self-contained post per file (article + spoken script);
  created by `bun run new-post <slug>`.
- `posts/common-terms.pls` — optional cross-post pronunciation lexicon (add one
  when a term keeps getting mispronounced).
- `figures/*.{ts,css}` — this blog's animated figures (content, not engine);
  add them per post as needed.
- `index.html` — the landing page (list each post's link here; the starter has
  a commented example showing the shape).
- `index.ts` / `worker.ts` — thin entry points that call the engine factories.
- `wrangler.toml` / `.env` — per-blog config (worker name, R2 bucket, secrets).
- `bunfig.toml` — registers the engine's HTML-head plugin for the dev server
  (createDevServer asserts it at startup) and mirrors the engine's
  supply-chain install policy.
- `manifest.webmanifest` / `icons/` — the PWA install surface (content-owned:
  your blog's name and launcher icons; the engine's service worker precaches
  the manifest, so these must exist for offline reading to install). The
  starter icons are placeholders — replace them with your own.
- `engine` — a symlink pointing **directly at the sibling engine repo**
  (`../presidocs`), so posts can reference engine assets as
  `../engine/client/narratorLoader.ts` and Bun's bundler resolves + bundles them into
  same-origin assets. It is *the real engine in one hop* — not an indirection
  through `node_modules`. (`node_modules/presidocs` is a separate single symlink
  to the same checkout, used only to resolve bare `presidocs/…` imports in
  `index.ts`/`worker.ts`.)

## Setup

The engine is a sibling checkout consumed via `bun link`, which is a one-time,
per-machine registration. Register it first — otherwise `bun install` fails
with "failed linking … package presidocs":

```sh
( cd ../presidocs && bun link )       # register the engine as linkable (once per machine)
bun install                           # links presidocs/ + installs content deps
ln -sfn ../presidocs engine           # if the symlink isn't present
cp .env.example .env                  # fill in secrets for OAuth/comments
```

## Commands

```sh
bun run dev          # dev server with HMR (regenerates the dev route table)
bun run new-post <slug> # scaffold a new post (posts/<slug>.html + author wiring)
bun run generate posts/hello.html       # build narration audio (say, fast)
bun run generate:prod posts/hello.html  # production voice (MOSS clone)
bun run build        # bundle to dist/
bun run deploy       # build + wrangler deploy
bun run clean <slug> # delete a post's generated audio + GC the TTS cache
```

## Private blog

This same starter runs a **private** blog, where **the URL is the secret**: the
engine's whole discovery surface (sitemap, feeds, llms.txt, landing post list,
Ask-this-blog, publish webhooks) is suppressed and re-audited on every build, and
every response carries `noindex`. Read the full design + threat model at engine
`methodology.md` → **Private blogs** before trusting it with anything serious
(notably: anyone holding a link can reshare it).

Four edits turn this blog private — nothing else:

- Set `BLOG_PRIVATE=1` in `.env` (the commented knob is already in `.env.example`).
- Point `build` and `deploy` at their `--private` forms in `package.json` — see the
  `"//private"` breadcrumb key there for the exact two lines. `--private` makes the
  posture *structural*, so audit-private still fires even if `.env` is lost.
- Swap the landing to the commented private variant in `index.html` (delete the
  public block, uncomment the private one).

`bun run new-post <slug>` mints the unguessable `--<token>` suffix for you — never
hand-invent tokens (the audit rejects filenames without one). **Renaming a file
rotates its key**: leak recovery is rename, rebuild, redeploy (the old link 404s).

**Keep the repo itself private on GitHub** — blog-level privacy means source,
figures, and generated audio are all covered by one repository ACL.

See `presidocs/methodology.md` for the engine's design and authoring rules.
