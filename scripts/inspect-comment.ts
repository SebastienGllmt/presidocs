// One-shot decoder for an .amrg file. Loads the Automerge doc and
// prints it as JSON so you can see what's actually in there.
//
// Usage:  bun scripts/inspect-comment.ts <path-to-.amrg>
// Example: bun scripts/inspect-comment.ts \
//   generated/.comments-dev/comments/posts/hash-functions/google:1234567890.amrg

import { next as Automerge } from "@automerge/automerge";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun scripts/inspect-comment.ts <path-to-.amrg>");
  process.exit(1);
}

const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
const doc = Automerge.load(bytes);
console.log("=== doc contents ===");
console.log(JSON.stringify(Automerge.toJS(doc), null, 2));
console.log("\n=== change history (op names) ===");
for (const change of Automerge.getHistory(doc)) {
  console.log(
    `  ${new Date(change.change.time).toISOString()}  ${change.change.message}`,
  );
}
