import "./_env";
import { closeDb, collections, ensureIndexes, ensureTextIndex, ensureVectorIndex } from "@/lib/db";

// Creates or updates the Atlas Vector Search index (dimensions read from a stored chunk). Usage: pnpm db:index
async function main() {
  const { chunks } = await collections();
  const sample = await chunks.findOne({ embedding: { $exists: true } }, { projection: { embedding: 1 } });
  if (!sample?.embedding) throw new Error("no embedded chunks yet: run pnpm ingest first");
  await ensureIndexes();
  await ensureVectorIndex(sample.embedding.length);
  await ensureTextIndex();
  console.log(`vector index (${sample.embedding.length} dims) and text index ready`);
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
