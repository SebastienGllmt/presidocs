import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { licenseFieldToString, resolveDepLicense } from "./licenseFiles.ts";

test("licenseFieldToString — SPDX string, legacy object, deprecated array, empty", () => {
  expect(licenseFieldToString({ license: "MIT" })).toBe("MIT");
  expect(
    licenseFieldToString({ license: "(CC-BY-4.0 AND OFL-1.1 AND MIT)" }),
  ).toBe("(CC-BY-4.0 AND OFL-1.1 AND MIT)");
  expect(licenseFieldToString({ license: { type: "Apache-2.0" } })).toBe(
    "Apache-2.0",
  );
  expect(
    licenseFieldToString({ licenses: [{ type: "MIT" }, { type: "ISC" }] }),
  ).toBe("MIT AND ISC");
  expect(licenseFieldToString({})).toBe("");
});

// Build a throwaway node_modules layout so the resolver test is deterministic
// (no coupling to the engine's actual installed dep versions).
function fakeEngineRoot(
  pkgs: Record<string, { pkgJson: object; files?: Record<string, string> }>,
): string {
  const root = mkdtempSync(join(tmpdir(), "license-files-"));
  for (const [name, { pkgJson, files }] of Object.entries(pkgs)) {
    const dir = join(root, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkgJson));
    for (const [f, content] of Object.entries(files ?? {})) {
      writeFileSync(join(dir, f), content);
    }
  }
  return root;
}

test("resolveDepLicense — reads version, license, and the LICENSE file text", () => {
  const root = fakeEngineRoot({
    widget: {
      pkgJson: {
        version: "1.2.3",
        license: "MIT",
        homepage: "https://w.example",
      },
      files: { "LICENSE.txt": "MIT License\n\nCopyright (c) someone\n" },
    },
  });
  const dep = resolveDepLicense("widget", root);
  expect(dep.name).toBe("widget");
  expect(dep.version).toBe("1.2.3");
  expect(dep.license).toBe("MIT");
  expect(dep.licenseText).toContain("Copyright (c) someone");
  expect(dep.noticeText).toBeNull();
  expect(dep.supplement).toBeNull();
  expect(dep.homepage).toBe("https://w.example");
});

test("resolveDepLicense — picks up an Apache NOTICE file alongside the LICENSE", () => {
  const root = fakeEngineRoot({
    apache: {
      pkgJson: { version: "2.0.0", license: "Apache-2.0" },
      files: {
        LICENSE: "Apache License 2.0 …",
        NOTICE: "Acme product\nincludes foo.",
      },
    },
  });
  const dep = resolveDepLicense("apache", root);
  expect(dep.licenseText).toContain("Apache License 2.0");
  expect(dep.noticeText).toContain("includes foo.");
});

test("resolveDepLicense — gsap-style: no LICENSE file → curated supplement, null text", () => {
  const root = fakeEngineRoot({
    gsap: {
      pkgJson: {
        version: "3.15.0",
        license:
          "Standard 'no charge' license: https://gsap.com/standard-license.",
      },
      files: { "README.md": "# gsap" },
    },
  });
  const dep = resolveDepLicense("gsap", root);
  expect(dep.licenseText).toBeNull();
  expect(dep.license).toContain("Standard 'no charge'");
  expect(dep.supplement).toContain("GreenSock");
  expect(dep.supplement).toContain("gsap.com/standard-license");
});

test("resolveDepLicense — throws when the package isn't installed", () => {
  const root = fakeEngineRoot({});
  expect(() => resolveDepLicense("ghost", root)).toThrow(
    /Cannot resolve installed package/,
  );
});
