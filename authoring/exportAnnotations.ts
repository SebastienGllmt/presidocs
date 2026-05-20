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
// `shared/annotationExport.ts`. Running the merge locally in Bun is
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

import { join, resolve } from "node:path";
import {
  loadUnresolvedThreads,
  type UnresolvedThread,
} from "./loadUnresolvedThreads.ts";
import { snapshotToAnnotationCollection } from "../shared/annotationExport.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

type CliArgs = {
  slug: string;
  all: boolean;
  base: string | null;
  out: string | null;
};

function parseArgs(argv: string[]): CliArgs {
  let slug: string | null = null;
  let all = false;
  let base: string | null = null;
  let out: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--all") {
      all = true;
    } else if (a === "--base") {
      base = argv[++i] ?? null;
      if (!base) throw new Error("--base requires a value");
    } else if (a === "--out") {
      out = argv[++i] ?? null;
      if (!out) throw new Error("--out requires a value");
    } else if (a === "-h" || a === "--help") {
      console.log(
        "Usage: bun authoring/exportAnnotations.ts <slug> [--all] [--base <iri>] [--out <file>]",
      );
      process.exit(0);
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    } else if (slug === null) {
      slug = a;
    } else {
      throw new Error(`unexpected positional arg: ${a}`);
    }
  }

  if (!slug) {
    console.error(
      "Usage: bun authoring/exportAnnotations.ts <slug> [--all] [--base <iri>] [--out <file>]",
    );
    process.exit(1);
  }
  return { slug, all, base, out };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const postPath = `/posts/${args.slug}`;

  const result = await loadUnresolvedThreads({
    postPath,
    commentsDir: join(PROJECT_ROOT, "generated", ".comments-dev"),
  });

  const entries: UnresolvedThread[] = args.all ? result.all : result.unresolved;
  const collection = snapshotToAnnotationCollection(
    entries.map((e) => e.thread),
    { slug: args.slug, baseIri: args.base ?? postPath },
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
