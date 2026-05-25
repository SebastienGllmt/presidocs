// Extract (id, related_offer_id) pairs where related_offers is non-empty.
// Streams the deduped JSONL; writes a tidy CSV for joining against offers.duckdb.
let buf = "";
const dec = new TextDecoder();
const out: string[] = ["offer_id,related_id,rel_count"];
let lines = 0, withRel = 0, totalRefs = 0;
const distCount: Record<number, number> = {};
for await (const chunk of Bun.file("generated/dexie-offers-dedup.jsonl").stream()) {
  buf += dec.decode(chunk, { stream: true });
  let n: number;
  while ((n = buf.indexOf("\n")) >= 0) {
    const l = buf.slice(0, n); buf = buf.slice(n + 1); lines++;
    try {
      const o = JSON.parse(l);
      const r = o.related_offers;
      if (Array.isArray(r) && r.length > 0) {
        withRel++;
        const c = r.length;
        distCount[c] = (distCount[c] ?? 0) + 1;
        for (const rid of r) { out.push(`${o.id},${rid},${c}`); totalRefs++; }
      }
    } catch {}
  }
}
await Bun.write("generated/related-offers.csv", out.join("\n") + "\n");
console.log("lines:", lines, "offers with related:", withRel, "total refs:", totalRefs);
console.log("rel_count distribution:", JSON.stringify(distCount));
