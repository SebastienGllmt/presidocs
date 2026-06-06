import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderShareCard, avatarDataUri, CARD_WIDTH, CARD_HEIGHT } from "./share-card.ts";

// Parse a PNG's IHDR for signature + dimensions.
function pngInfo(buf: Uint8Array): { isPng: boolean; width: number; height: number } {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const isPng = sig.every((b, i) => buf[i] === b);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { isPng, width: dv.getUint32(16), height: dv.getUint32(20) };
}

// ---- avatarDataUri: satori needs PNG/JPEG; WebP avatars fall back to a sibling -

test("avatarDataUri: a WebP avatar falls back to a same-name PNG sibling (satori can't decode WebP)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "presidocs-card-"));
  try {
    await writeFile(join(dir, "x.png"), new Uint8Array([1, 2, 3, 4]));
    await writeFile(join(dir, "x.webp"), new Uint8Array([5, 6, 7, 8]));
    // The engine resolves the WebP for browser delivery; the card must still get
    // the PNG sibling so the avatar renders.
    const uri = await avatarDataUri(join(dir, "x.webp"));
    expect(uri).toStartWith("data:image/png;base64,");
    // It's the PNG bytes (AQIDBA== = [1,2,3,4]), not the WebP's.
    expect(uri).toBe("data:image/png;base64,AQIDBA==");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("avatarDataUri: a WebP avatar with no raster sibling returns null (card degrades, no crash)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "presidocs-card-"));
  try {
    await writeFile(join(dir, "x.webp"), new Uint8Array([5, 6, 7, 8]));
    expect(await avatarDataUri(join(dir, "x.webp"))).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("avatarDataUri: a PNG avatar is used directly; null in → null out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "presidocs-card-"));
  try {
    await writeFile(join(dir, "y.png"), new Uint8Array([9, 9]));
    expect(await avatarDataUri(join(dir, "y.png"))).toStartWith("data:image/png;base64,");
    expect(await avatarDataUri(null)).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renders a valid 1200x630 PNG (satori + resvg + the vendored static font)", async () => {
  const png = await renderShareCard({
    siteName: "Presidocs",
    title: "What is a hash function?",
    authorName: "Sebastien Guillemot",
    avatarDataUri: null,
  });
  const info = pngInfo(png);
  expect(info.isPng).toBe(true);
  expect(info.width).toBe(CARD_WIDTH);
  expect(info.height).toBe(CARD_HEIGHT);
  expect(png.byteLength).toBeGreaterThan(1000);
});

test("the article title actually renders (different titles → different pixels)", async () => {
  const [a, b] = await Promise.all([
    renderShareCard({ siteName: "S", title: "Offer Files", authorName: "X", avatarDataUri: null }),
    renderShareCard({ siteName: "S", title: "Chia Offer Files by the Numbers", authorName: "X", avatarDataUri: null }),
  ]);
  expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).not.toBe(0);
});
