import { test, expect } from "bun:test";
import { renderShareCard, CARD_WIDTH, CARD_HEIGHT } from "./share-card.ts";

// Parse a PNG's IHDR for signature + dimensions.
function pngInfo(buf: Uint8Array): { isPng: boolean; width: number; height: number } {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const isPng = sig.every((b, i) => buf[i] === b);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { isPng, width: dv.getUint32(16), height: dv.getUint32(20) };
}

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
