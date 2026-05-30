# Presidocs

The reusable **blog engine** behind explanatory technical posts that double as
talks (narration player, live figures, OAuth comments, offline TTS pipeline,
Cloudflare deploy). This repo is the engine only — it contains **no posts of
its own**. Each blog is a separate content repo that depends on this one via a
`bun link` symlink (`"presidocs": "link:presidocs"`) to this sibling checkout.

See [`methodology.md`](./methodology.md) for the full design, and
[`templates/content-repo/`](./templates/content-repo) for the starter a new
blog copies. `../personal-blog` is a live instance.

```bash
bun install   # install engine deps
bun test      # run the engine test suite
bun link      # register this engine as linkable (once per machine; blogs consume it)
```

To start a new blog from the template:

```bash
cp -R templates/content-repo ../my-blog
bun link                               # register this engine (skip if already done)
cd ../my-blog
bun install                            # resolves "presidocs": "link:presidocs" → a single symlink
ln -sfn ../presidocs engine            # so posts can reference ../engine/client/*
cp .env.example .env                   # fill in OAuth / SESSION_SECRET
bun run dev
```
