import { expect, test } from "bun:test";
import {
  type BunMetafile,
  packageNameFromInput,
  packagesFromMetafile,
} from "./clientDeps.ts";

test("packageNameFromInput — unscoped, scoped, and non-package paths", () => {
  expect(packageNameFromInput("node_modules/zod/v4/core/schemas.js")).toBe(
    "zod",
  );
  expect(
    packageNameFromInput("node_modules/@automerge/automerge/dist/index.js"),
  ).toBe("@automerge/automerge");
  expect(packageNameFromInput("client/citationLink.ts")).toBeNull();
  expect(packageNameFromInput("shared/blogPaths.ts")).toBeNull();
});

test("packageNameFromInput — nested node_modules resolves to the INNER package", () => {
  // A dep's own bundled dep: the byte-bearing module is the inner package.
  expect(packageNameFromInput("node_modules/a/node_modules/b/index.js")).toBe(
    "b",
  );
  expect(
    packageNameFromInput("node_modules/@s/a/node_modules/@t/b/index.js"),
  ).toBe("@t/b");
});

test("packagesFromMetafile — keeps only packages with bytes in an output chunk", () => {
  const mf: BunMetafile = {
    inputs: {},
    outputs: {
      "dist/chunk-1.js": {
        inputs: {
          "node_modules/zod/index.js": { bytesInOutput: 1200 },
          "node_modules/tree-shaken/index.js": { bytesInOutput: 0 }, // DCE'd → dropped
          "client/identity.ts": { bytesInOutput: 80 }, // first-party → no package
        },
      },
      "dist/chunk-2.js": {
        inputs: {
          "node_modules/@automerge/automerge/index.js": { bytesInOutput: 4000 },
        },
      },
    },
  };
  expect(packagesFromMetafile(mf)).toEqual(["@automerge/automerge", "zod"]);
});

test("packagesFromMetafile — dedupes a package split across chunks, returns sorted", () => {
  const mf: BunMetafile = {
    inputs: {},
    outputs: {
      a: { inputs: { "node_modules/zod/a.js": { bytesInOutput: 10 } } },
      b: { inputs: { "node_modules/zod/b.js": { bytesInOutput: 10 } } },
      c: { inputs: { "node_modules/gsap/index.js": { bytesInOutput: 10 } } },
    },
  };
  expect(packagesFromMetafile(mf)).toEqual(["gsap", "zod"]);
});

test("packagesFromMetafile — a missing bytesInOutput is treated as zero (not shipped)", () => {
  const mf: BunMetafile = {
    inputs: {},
    outputs: { a: { inputs: { "node_modules/maybe/index.js": {} } } },
  };
  expect(packagesFromMetafile(mf)).toEqual([]);
});
