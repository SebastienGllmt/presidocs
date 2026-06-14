import { expect, test } from "bun:test";
import type { DepLicense } from "./licenseFiles.ts";
import {
  buildLicensesHtml,
  buildLicensesTxt,
  groupByLicense,
  type LicensesContext,
  SELF_HOSTED_FONTS,
} from "./licenses-page.ts";

// `in` checks so an explicit `null` (e.g. gsap shipping no LICENSE file) is not
// resurrected to the default by `??`.
function dep(
  name: string,
  license: string,
  extra: Partial<DepLicense> = {},
): DepLicense {
  return {
    name,
    version: "1.0.0",
    license,
    licenseText:
      "licenseText" in extra
        ? (extra.licenseText ?? null)
        : `LICENSE TEXT for ${name}`,
    noticeText: "noticeText" in extra ? (extra.noticeText ?? null) : null,
    supplement: "supplement" in extra ? (extra.supplement ?? null) : null,
    homepage: extra.homepage ?? null,
  };
}

const DEPS: DepLicense[] = [
  dep("zod", "MIT"),
  dep("@automerge/automerge", "MIT"),
  dep("text-fragments-polyfill", "Apache-2.0"),
  dep("@fortawesome/fontawesome-free", "(CC-BY-4.0 AND OFL-1.1 AND MIT)", {
    licenseText: "Creative Commons Attribution 4.0 …",
  }),
  dep(
    "gsap",
    "Standard 'no charge' license: https://gsap.com/standard-license.",
    {
      licenseText: null,
      supplement:
        "GreenSock's custom no-charge license; terms at https://gsap.com/standard-license/",
    },
  ),
];

test("groupByLicense — MIT then Apache-2.0 first, other licenses alphabetical, each its own group", () => {
  const groups = groupByLicense(DEPS);
  expect(groups.map((g) => g.license)).toEqual([
    "MIT",
    "Apache-2.0",
    "(CC-BY-4.0 AND OFL-1.1 AND MIT)", // outliers grouped alone, alpha order
    "Standard 'no charge' license: https://gsap.com/standard-license.",
  ]);
  // Deps within the MIT group are sorted by name.
  expect(groups[0]!.deps.map((d) => d.name)).toEqual([
    "@automerge/automerge",
    "zod",
  ]);
  // Each non-standard license isolates a single dep — that's the prominence.
  expect(groups[2]!.deps.map((d) => d.name)).toEqual([
    "@fortawesome/fontawesome-free",
  ]);
  expect(groups[3]!.deps.map((d) => d.name)).toEqual(["gsap"]);
});

function ctx(overrides: Partial<LicensesContext> = {}): LicensesContext {
  return {
    siteTitle: "Test Blog",
    lang: "en",
    cssLinks: '<link rel="stylesheet" href="/x.css">',
    private: false,
    ownContent: {
      id: "CC-BY-4.0",
      url: "https://creativecommons.org/licenses/by/4.0/",
    },
    ownCode: { id: "MIT", url: "https://opensource.org/license/mit" },
    ownLicenseServed: true,
    ownLicenseText: "# License\nCC-BY-4.0 / MIT\n",
    fonts: SELF_HOSTED_FONTS,
    groups: groupByLicense(DEPS),
    ...overrides,
  };
}

test("buildLicensesHtml — own license, fonts, each group heading, and every dep name", () => {
  const html = buildLicensesHtml(ctx());
  expect(html).toContain(
    "<title>Licenses &amp; acknowledgements — Test Blog</title>",
  );
  // Own license: both halves linked with rel=license, plus the self-hosted text.
  expect(html).toContain('rel="license">CC-BY-4.0</a>');
  expect(html).toContain('rel="license">MIT</a>');
  expect(html).toContain('href="/license"');
  // Fonts notice (OFL) visible.
  expect(html).toContain("Red Hat");
  expect(html).toContain("/fonts/OFL.txt");
  // Every group heading + dep present.
  expect(html).toContain("<h3>MIT</h3>");
  expect(html).toContain("<h3>Apache-2.0</h3>");
  expect(html).toContain("<h3>(CC-BY-4.0 AND OFL-1.1 AND MIT)</h3>");
  for (const d of DEPS) expect(html).toContain(`<strong>${d.name}</strong>`);
});

test("buildLicensesHtml — carries the build-tools blanket note", () => {
  expect(buildLicensesHtml(ctx())).toContain(
    "build-tool-injected runtime helpers remain under their respective licenses",
  );
});

test("buildLicensesHtml — CC-BY license text is rendered (CC-BY visible-attribution duty)", () => {
  const html = buildLicensesHtml(ctx());
  expect(html).toContain("Creative Commons Attribution 4.0");
  // gsap has no license file → its supplement shows instead of an empty <details>.
  expect(html).toContain("GreenSock's custom no-charge license");
});

test("buildLicensesHtml — private blog carries a noindex meta", () => {
  expect(buildLicensesHtml(ctx({ private: true }))).toContain(
    '<meta name="robots" content="noindex" />',
  );
  expect(buildLicensesHtml(ctx({ private: false }))).not.toContain("noindex");
});

test("buildLicensesHtml — no declared own license → graceful 'not declared' line", () => {
  const html = buildLicensesHtml(
    ctx({
      ownContent: null,
      ownCode: null,
      ownLicenseServed: false,
      ownLicenseText: null,
    }),
  );
  expect(html).toContain("has not declared its own reuse license");
});

test("buildLicensesTxt — sections, own license text, per-dep license/supplement", () => {
  const txt = buildLicensesTxt(ctx());
  expect(txt).toContain("THIS BLOG'S OWN CONTENT AND CODE");
  expect(txt).toContain("Prose / figures / audio: CC-BY-4.0");
  expect(txt).toContain("Code samples / figure source: MIT");
  expect(txt).toContain("CC-BY-4.0 / MIT"); // the raw LICENSE.md text
  expect(txt).toContain("FONTS");
  expect(txt).toContain(
    "Red Hat Text & Red Hat Mono — OFL-1.1 — /fonts/OFL.txt",
  );
  expect(txt).toContain("THIRD-PARTY CODE BUNDLED INTO THIS SITE");
  expect(txt).toContain("zod 1.0.0 — MIT");
  expect(txt).toContain("LICENSE TEXT for zod");
  expect(txt).toContain("GreenSock's custom no-charge license"); // gsap supplement
  expect(txt).toContain("build-tool-injected runtime helpers"); // blanket note
});
