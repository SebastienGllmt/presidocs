import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasOwnLicenseFile,
  OWN_LICENSE_FILENAME,
  ownLicenseSourcePath,
  resolveLicenseLinkHref,
  SERVED_LICENSE_PATH,
} from "./servedLicense.ts";

const DEED = "https://creativecommons.org/licenses/by/4.0/";

function emptyRoot(): string {
  return mkdtempSync(join(tmpdir(), "served-license-"));
}
function rootWithLicense(): string {
  const dir = emptyRoot();
  writeFileSync(
    join(dir, OWN_LICENSE_FILENAME),
    "# License\nCC-BY-4.0 / MIT\n",
  );
  return dir;
}

test("ownLicenseSourcePath joins LICENSE.md onto the content root", () => {
  const root = emptyRoot();
  expect(ownLicenseSourcePath(root)).toBe(join(root, "LICENSE.md"));
});

test("hasOwnLicenseFile — true only when LICENSE.md exists", () => {
  expect(hasOwnLicenseFile(rootWithLicense())).toBe(true);
  expect(hasOwnLicenseFile(emptyRoot())).toBe(false);
});

test("resolveLicenseLinkHref — retargets to /license when LICENSE.md ships", () => {
  expect(resolveLicenseLinkHref(DEED, rootWithLicense())).toBe(
    SERVED_LICENSE_PATH,
  );
});

test("resolveLicenseLinkHref — falls back to the external deed with no LICENSE.md", () => {
  expect(resolveLicenseLinkHref(DEED, emptyRoot())).toBe(DEED);
});

test("resolveLicenseLinkHref — empty deed (no CONTENT_LICENSE) → empty, even with a LICENSE.md", () => {
  // No declared license means no footer license link at all; serving a
  // LICENSE.md must not conjure one out of an unset CONTENT_LICENSE.
  expect(resolveLicenseLinkHref("", rootWithLicense())).toBe("");
  expect(resolveLicenseLinkHref("", emptyRoot())).toBe("");
});
