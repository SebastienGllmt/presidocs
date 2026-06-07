import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAuthorProfile, buildAuthorMap } from "./authorProfile.ts";

// Profiles are keyed by <author-email>, mirroring authors/<author-email>.wav.
// The load-bearing invariant: nothing the resolver returns for serving may
// contain the email — the served avatar URL must use the public handle.
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "author-prof-"));
  mkdirSync(join(root, "authors"), { recursive: true });
  mkdirSync(join(root, "posts"), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeProfile(email: string, obj: unknown) {
  writeFileSync(join(root, "authors", `${email}.json`), JSON.stringify(obj));
}
function writeAvatar(email: string, ext = "png") {
  writeFileSync(join(root, "authors", `${email}.${ext}`), new Uint8Array(4));
}
function writePost(slug: string, email: string | null) {
  const meta = email ? `<meta name="author-email" content="${email}" />` : "";
  writeFileSync(
    join(root, "posts", `${slug}.html`),
    `<!DOCTYPE html><html><head>${meta}<title>${slug}</title></head><body></body></html>`,
  );
}

test("resolves name, links, and an avatar URL keyed by the public handle", async () => {
  writeProfile("alice@example.com", {
    name: "Alice Example",
    handle: "AliceX",
    links: { x: "https://x.com/AliceX" },
  });
  writeAvatar("alice@example.com");
  const r = await resolveAuthorProfile(root, "alice@example.com");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.author.profile.name).toBe("Alice Example");
  expect(r.author.profile.links.x).toBe("https://x.com/AliceX");
  // Served URL uses the lowercased public handle — never the email.
  expect(r.author.profile.avatar).toBe("/assets/authors/alicex.png");
  expect(r.author.avatarServedName).toBe("alicex.png");
  expect(r.author.profile.avatar).not.toContain("@");
  expect(r.author.profile.avatar).not.toContain("alice@example.com");
});

test("derives the handle from the X link when not given explicitly", async () => {
  writeProfile("bob@example.com", {
    name: "Bob",
    links: { x: "https://x.com/BobHandle/" },
  });
  writeAvatar("bob@example.com", "jpg");
  const r = await resolveAuthorProfile(root, "bob@example.com");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.author.profile.avatar).toBe("/assets/authors/bobhandle.jpg");
});

test("falls back to a name slug when there is no handle or X link", async () => {
  writeProfile("carol@example.com", { name: "Carol Q. Public" });
  writeAvatar("carol@example.com");
  const r = await resolveAuthorProfile(root, "carol@example.com");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.author.profile.avatar).toBe("/assets/authors/carol-q.-public.png");
});

test("folds Latin accents deterministically — no explicit handle needed", async () => {
  // NFKD-foldable accents have one unambiguous ASCII form, so we don't force an
  // explicit handle for them: José → jose, café → cafe, Nguyễn → nguyen.
  writeProfile("jose@example.com", { name: "José" });
  writeAvatar("jose@example.com");
  const r = await resolveAuthorProfile(root, "jose@example.com");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.author.profile.avatar).toBe("/assets/authors/jose.png");
});

test("a non-Latin name without an explicit handle is FATAL (no silent 'author' collision)", async () => {
  // A kanji/Cyrillic/etc. name can't be romanized unambiguously — we refuse to
  // guess and require the author to choose an explicit ASCII handle.
  writeProfile("tanaka@example.com", { name: "田中" });
  writeAvatar("tanaka@example.com");
  const r = await resolveAuthorProfile(root, "tanaka@example.com");
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.fatal).toBe(true);
  expect(r.reason).toContain("explicit ASCII `handle`");
});

test("an explicit ASCII handle is the escape hatch for a non-Latin name", async () => {
  writeProfile("tanaka@example.com", { name: "田中", handle: "tanaka" });
  writeAvatar("tanaka@example.com");
  const r = await resolveAuthorProfile(root, "tanaka@example.com");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.author.profile.avatar).toBe("/assets/authors/tanaka.png");
});

test("a non-ASCII EXPLICIT handle is also fatal (the handle must itself be ASCII)", async () => {
  writeProfile("tanaka@example.com", { name: "Tanaka", handle: "田中" });
  writeAvatar("tanaka@example.com");
  const r = await resolveAuthorProfile(root, "tanaka@example.com");
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.fatal).toBe(true);
});

test("buildAuthorMap FAILS THE BUILD on a non-romanizable handle (not a silent skip)", async () => {
  writeProfile("tanaka@example.com", { name: "田中" });
  writeAvatar("tanaka@example.com");
  writePost("post-jp", "tanaka@example.com");
  expect(buildAuthorMap(join(root, "posts"), root)).rejects.toThrow(/explicit ASCII/);
});

test("prefers the WebP avatar when both WebP and PNG exist (optimized browser delivery)", async () => {
  writeProfile("erin@example.com", { name: "Erin", handle: "ErinE" });
  writeAvatar("erin@example.com", "png"); // raster source kept for share cards
  writeAvatar("erin@example.com", "webp"); // optimized, served to browsers
  const r = await resolveAuthorProfile(root, "erin@example.com");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.author.profile.avatar).toBe("/assets/authors/erine.webp");
  expect(r.author.avatarServedName).toBe("erine.webp");
});

test("renders text-only (avatar null) when no avatar file exists", async () => {
  writeProfile("dave@example.com", { name: "Dave" });
  const r = await resolveAuthorProfile(root, "dave@example.com");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.author.profile.avatar).toBeNull();
  expect(r.author.avatarServedName).toBeNull();
});

test("fails clearly when the profile is missing", async () => {
  const r = await resolveAuthorProfile(root, "ghost@example.com");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toMatch(/authors\/ghost@example\.com\.json/);
});

test("fails when the profile has no name", async () => {
  writeProfile("nameless@example.com", { links: { x: "https://x.com/x" } });
  const r = await resolveAuthorProfile(root, "nameless@example.com");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toMatch(/no "name"/);
});

test("refuses an email that would escape the authors/ dir", async () => {
  const r = await resolveAuthorProfile(root, "../etc/passwd");
  expect(r.ok).toBe(false);
});

test("buildAuthorMap keys by post path, dedupes avatars, and leaks no email", async () => {
  writeProfile("alice@example.com", {
    name: "Alice",
    handle: "AliceX",
    links: { x: "https://x.com/AliceX" },
  });
  writeAvatar("alice@example.com");
  writePost("first", "alice@example.com");
  writePost("second", "alice@example.com"); // same author → shared avatar
  writePost("orphan", "ghost@example.com"); // no profile → omitted
  writePost("anon", null); // no author-email → omitted

  const warnings: string[] = [];
  const { map, avatars } = await buildAuthorMap(
    join(root, "posts"),
    root,
    (m) => warnings.push(m),
  );

  expect(Object.keys(map).sort()).toEqual(["/posts/first", "/posts/second"]);
  expect(map["/posts/first"]!.name).toBe("Alice");
  // One avatar entry despite two posts; keyed by the public served name.
  expect(Object.keys(avatars)).toEqual(["alicex.png"]);
  // The orphan author (no profile) produced a warning, not a thrown build.
  expect(warnings.some((w) => w.includes("/posts/orphan"))).toBe(true);

  const serialized = JSON.stringify(map);
  expect(serialized).not.toContain("@example.com");
});
