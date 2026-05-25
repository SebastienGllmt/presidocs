// Pipeline step 2 of 3:  crawl-dexie.ts → [dedup-dexie.ts] → aggregate-charts.ts
//
// The raw crawl dump (generated/dexie-offers-full.jsonl, ~3.9 GB) contains
// DUPLICATES by design (multi-leg offers match several asset partitions; overflow
// paging overlaps its sub-queries). This step removes those duplicates and NOTHING
// else: it keeps the first occurrence of each stable `id` and writes the record
// out VERBATIM — every field preserved (token `name`, the `offer` blob,
// `involved_coins`, `mempool`, …). Lossless.
//
// Run: bun research/dexie-offers/pipeline/dedup-dexie.ts
// In:  generated/dexie-offers-full.jsonl
// Out: generated/dexie-offers-dedup.jsonl   (deduped by id; one offer per line, full fidelity)

const IN = "generated/dexie-offers-full.jsonl";
const OUT = "generated/dexie-offers-dedup.jsonl";

const seen = new Set<string>();
let lines = 0, unique = 0, bad = 0, lastLog = 0;
const dec = new TextDecoder();
let buf = "";
const out = Bun.file(OUT).writer();

function handle(line: string): void {
  lines++;
  let id: string | undefined;
  try { id = JSON.parse(line)?.id; } catch { bad++; return; } // parse only to read the id…
  if (!id || seen.has(id)) return;
  seen.add(id);
  unique++;
  out.write(line + "\n"); // …then write the ORIGINAL line unchanged (no fields dropped)
}

const reader = Bun.file(IN).stream().getReader();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); if (l) handle(l); }
  if (lines - lastLog >= 200000) { lastLog = lines; process.stderr.write(`  read ${lines.toLocaleString()} lines, ${unique.toLocaleString()} unique…\n`); }
}
if (buf) handle(buf);
await out.end();

const inMB = (Bun.file(IN).size / 1e6).toFixed(0);
const outMB = (Bun.file(OUT).size / 1e6).toFixed(0);
console.error(`\nDone.`);
console.error(`  in:  ${lines.toLocaleString()} lines (${inMB} MB)${bad ? ` · ${bad} unparseable` : ""}`);
console.error(`  out: ${unique.toLocaleString()} unique offers → ${OUT} (${outMB} MB) — full records, nothing dropped`);
