# e2e fixture content overlay

The engine's e2e harness (`e2e/harness.ts`) does **not** run against these files
in place. It materializes a bootable blog into a scratch dir outside the repo
(`~/.cache/presidocs-e2e/<hash>/` by default, or `PRESIDOCS_E2E_FIXTURE_ROOT`)
by copying the tracked `templates/content-repo` tree and then layering this
overlay on top (overlay wins on collision). Nothing here is built in place, so a
full `bun run test:e2e*` leaves `git status` clean.

- `blog/` — the PUBLIC fixture overlay: the `hello` post, its `common-terms.pls`
  lexicon and `versions.json` seed, the `heartbeat` figure pair, the landing
  `index.html` that lists the post, and `generated/hello/` — the committed
  espeak narration audio (prodAudioSmoke + the subscribe tier require audio on
  disk; a `.gitignore` negation keeps the bare `generated` pattern from
  swallowing it).
- `private-blog/` — the PRIVATE fixture overlay: the capability-URL landing (no
  post links) + the `welcome--<token>` post and its `versions.json`. The private
  fixture materializes from the SAME public template plus this overlay, with
  `BLOG_PRIVATE=1` and `--private` build/deploy scripts the harness patches in.

## Maintenance contract

Two seeds must stay in sync with the post bytes, or a fresh materialization's
first build appends a version (harmless, but noisy in goldens):

1. **`posts/versions.json`** — after editing a fixture post, run one build in the
   materialized fixture (`cd "$(bun -e "import('./e2e/harness.ts').then(h=>console.log(h.ensureFixtureBlog()))")" && bun run build`)
   and copy the appended `versions.json` back into this overlay.
2. **`blog/generated/hello/`** — after changing the `hello` post's narration,
   regenerate the audio (espeak, ~2 min; recipe:
   `proposals/refactor/phase4/4.3-generate-stages.md` D7/§6) and copy the new
   mp3s + `manifest.*.json` back here.
