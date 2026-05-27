# my-blog

A blog built on the shared **presidocs** blog engine, kept in its own
repository. The engine (narration player, comment system, build/TTS pipeline)
is pulled in as a `file:` dependency; this repo holds only content:

- `posts/*.html` — one self-contained post per file (article + spoken script).
- `posts/common-terms.pls` — cross-post pronunciation lexicon.
- `figures/*.{ts,css}` — this blog's animated figures (content, not engine).
- `index.html` — the landing page.
- `index.ts` / `worker.ts` — thin entry points that call the engine factories.
- `wrangler.toml` / `.env` — per-blog config (worker name, R2 bucket, secrets).
- `engine` — a symlink to `node_modules/presidocs`, so posts can reference
  engine assets as `../engine/client/narrator.ts` and Bun's bundler resolves
  + bundles them into same-origin assets.

## Setup

```sh
bun install
ln -s node_modules/presidocs engine   # if the symlink isn't present
cp .env.example .env                   # fill in secrets for OAuth/comments
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
