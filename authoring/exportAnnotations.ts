#!/usr/bin/env bun
//
// Export a post's comments as a W3C Web Annotation `AnnotationCollection`
// (JSON-LD). This is Phase B of the Web Annotation adoption — the
// interop surface that lets the comments leave our app in a portable,
// standard shape (importable by Hypothes.is, dokieli, EPUB readers, …).
//
// It reuses the same offline aggregation the comment-applier uses
// (`loadUnresolvedThreads` — merges every reader's per-user CRDT blob
// from the dev fsAdapter), then runs the pure serializer in
// `authoring/annotationExport.ts`. Running the merge locally in Bun is
// fine: the dumb-server rule is a *production* constraint (see
// methodology.md), and this tool never runs in prod.
//
// Usage:
//   bun authoring/exportAnnotations.ts <slug> [--all] [--base <iri>] [--out <file>]
//
//   --all          include resolved threads too (default: only the
//                  threads still needing attention — the same set the
//                  applier sees). Resolved annotations carry an
//                  `x-blog:resolvedAt` extension.
//   --base <iri>   base IRI the target `source` resolves against
//                  (default: `/posts/<slug>`). Pass a full
//                  `https://…/posts/<slug>` for a portable absolute export.
//   --out <file>   write to a file instead of stdout.

import { join } from "node:path";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { parseCliArgs } from "../shared/cliArgs.ts";
import {
  loadUnresolvedThreads,
  type UnresolvedThread,
} from "./loadUnresolvedThreads.ts";
import { snapshotToAnnotationCollection } from "./annotationExport.ts";

const paths = resolveBlogPaths();

type CliArgs = {
  slug: string;
  all: boolean;
  base: string | null;
  out: string | null;
};

const USAGE =
  "Usage: bun authoring/exportAnnotations.ts <slug> [--all] [--base <iri>] [--out <file>]";

function parseCli(argv: string[]): CliArgs {
  // `parseArgs` (via the shared wrapper) gives us strict unknown-flag rejection,
  // `--x val`/`--x=val` both, value-required checks, and `-h` for free — the
  // hand-rolled loop this replaced did all of that by hand.
  const { values, positionals } = parseCliArgs(
    {
      args: argv,
      allowPositionals: true,
      options: {
        all: { type: "boolean" },
        base: { type: "string" },
        out: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    },
    { usage: USAGE, exitCode: 1 },
  );

  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (positionals.length !== 1) {
    console.error(USAGE); // missing slug, or an unexpected extra positional
    process.exit(1);
  }
  return {
    slug: positionals[0]!,
    all: values.all ?? false,
    base: values.base ?? null,
    out: values.out ?? null,
  };
}

async function main() {
  const args = parseCli(process.argv.slice(2));
  const postPath = `/posts/${args.slug}`;

  const result = await loadUnresolvedThreads({
    postPath,
    commentsDir: join(paths.generatedDir, ".comments-dev"),
  });

  const entries: UnresolvedThread[] = args.all ? result.all : result.unresolved;
  const collection = snapshotToAnnotationCollection(
    entries.map((e) => e.thread),
    { slug: args.slug, baseIri: args.base ?? postPath },
    // Per-thread/per-reply birth store (`x-blog:origin`) — lets a consumer
    // (notably the process-comments skill) tell reader feedback
    // (production) from the author's localhost scaffolding replies.
    new Map(entries.map((e) => [e.thread.id, e.origins])),
  );

  const json = JSON.stringify(collection, null, 2);
  if (args.out) {
    await Bun.write(args.out, json + "\n");
    console.error(
      `Wrote ${collection.total} annotation(s) to ${args.out}` +
        ` (${args.all ? "all" : "unresolved only"}).`,
    );
  } else {
    console.log(json);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
