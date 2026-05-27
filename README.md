# Presidocs

The reusable **blog engine** behind explanatory technical posts that double as
talks (narration player, live figures, OAuth comments, offline TTS pipeline,
Cloudflare deploy). This repo is the engine only — it contains **no posts of
its own**. Each blog is a separate content repo that depends on this one via a
`file:` dependency.

See [`methodology.md`](./methodology.md) for the full design, and
[`templates/content-repo/`](./templates/content-repo) for the starter a new
blog copies. `../personal-blog` is a live instance.

```bash
bun install   # install engine deps
bun test      # run the engine test suite
```

To start a new blog from the template:

```bash
cp -R templates/content-repo ../my-blog
cd ../my-blog && bun install
ln -s node_modules/presidocs engine   # so posts can reference ../engine/client/*
cp .env.example .env                   # fill in OAuth / SESSION_SECRET
bun run dev
```
