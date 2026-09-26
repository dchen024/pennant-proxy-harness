import "./_env";
import fs from "node:fs/promises";
import path from "node:path";
import { PARSER_VERSION } from "@/lib/config";
import { closeDb, collections, ensureIndexes, ensureTextIndex, ensureVectorIndex } from "@/lib/db";
import { embed } from "@/lib/openrouter";
import { parsePdf } from "@/lib/pdf/parse";
import type { FilingDoc } from "@/lib/types";
import type { ManifestEntry } from "./fetch-filings";

// Parses each filing PDF into page-anchored chunks, embeds them with Voyage (via OpenRouter)
// and stores them in MongoDB Atlas with a vector index.
// Usage: pnpm ingest [--tickers AAPL] [--parse-only]   (--parse-only dumps chunks to data/chunks/ without DB or embeddings)

async function main() {
  const arg = process.argv.indexOf("--tickers");
  const only = arg > -1 ? process.argv[arg + 1].split(",") : null;
  const parseOnly = process.argv.includes("--parse-only");
  const manifest: Record<string, ManifestEntry> = JSON.parse(await fs.readFile("data/filings/manifest.json", "utf8"));
  const entries = Object.values(manifest).filter((m) => !only || only.includes(m.ticker));
  let dims = 0;

  for (const m of entries) {
    const t0 = Date.now();
    const { pages, chunks } = await parsePdf(path.join("public", m.pdfPath), m.ticker, PARSER_VERSION);
    const tables = chunks.filter((c) => c.kind === "table").length;
    await fs.mkdir("data/chunks", { recursive: true });
    await fs.writeFile(`data/chunks/${m.ticker}.json`, JSON.stringify(chunks.map(({ _id, page, kind, text }) => ({ _id, page, kind, text })), null, 1));
    console.log(`${m.ticker}: ${pages.length} pages → ${chunks.length} chunks (${tables} table) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (parseOnly) continue;

    const vectors = await embed(chunks.map((c) => (c.context ? `${c.context}\n${c.text}` : c.text)));
    chunks.forEach((c, i) => (c.embedding = vectors[i]));
    dims = vectors[0]?.length ?? dims;

    const c = await collections();
    const filing: FilingDoc = { _id: m.ticker, ...m, pages, parserVersion: PARSER_VERSION };
    await c.filings.replaceOne({ _id: m.ticker }, filing, { upsert: true });
    await c.chunks.deleteMany({ ticker: m.ticker, parserVersion: PARSER_VERSION });
    await c.chunks.insertMany(chunks);
    await c.retrievals.deleteMany({ ticker: m.ticker, _id: { $regex: `:${PARSER_VERSION}(:hybrid)?$` } }); // cached retrievals point at old chunks
    console.log(`${m.ticker}: embedded (${dims} dims) and stored in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  if (!parseOnly && dims) {
    await ensureIndexes();
    console.log("waiting for the vector index to be queryable…");
    await ensureVectorIndex(dims);
    await ensureTextIndex();
    console.log("vector + text indexes ready");
  }
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
