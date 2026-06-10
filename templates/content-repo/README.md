# my-blog

A blog built on the shared **presidocs** blog engine, kept in its own
repository. The engine (narration player, comment system, build/TTS pipeline)
lives in the sibling `../presidocs` checkout and is linked in via `bun link`
(`"presidocs": "link:presidocs"`), so `node_modules/presidocs` is a single
symlink to that checkout — engine edits are picked up live, with no per-file
copy or symlink "farm" to go stale. This repo holds only content:

- `posts/*.html` — one self-contained post per file (article + spoken script).
- `posts/common-terms.pls` — cross-post pronunciation lexicon.
- `figures/*.{ts,css}` — this blog's animated figures (content, not engine).
- `index.html` — the landing page.
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
bun run generate posts/hello.html       # build narration audio (say, fast)
bun run generate:prod posts/hello.html  # production voice (MOSS clone)
bun run build        # bundle to dist/
bun run deploy       # build + wrangler deploy
bun run clean <slug> # delete a post's generated audio + GC the TTS cache
```

See `presidocs/methodology.md` for the engine's design and authoring rules.

## Note: this template is also the engine's e2e fixture

The engine's real-browser test suite (`presidocs/e2e/`) drives this directory
by default (methodology → Testing layout). Its harness materializes the same
setup products the Setup section above describes — the `engine` symlink,
`node_modules`, and a generated `.env`/`.dev.vars` secret — all gitignored
here, so a `bun run test:e2e` in the engine leaves this template's tree
clean. If those files appear after running the engine's tests, that's the
fixture bootstrap, not something to commit. (One exception: the heavy
wrangler tiers run a real `bun run build`, which — as on any content repo —
appends to `posts/versions.json` when a post's content changed; fold that
into the post's commit or discard it.)
