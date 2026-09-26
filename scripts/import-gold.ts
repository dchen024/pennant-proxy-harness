import "./_env";
import fs from "node:fs/promises";
import { closeDb, collections } from "@/lib/db";
import type { GoldFact } from "@/lib/types";

// Restore the answer key from data/gold/gold.json into a (new) database. Usage: pnpm gold:import
async function main() {
  const docs: GoldFact[] = JSON.parse(await fs.readFile("data/gold/gold.json", "utf8"));
  const c = await collections();
  if (docs.length) {
    await c.gold.bulkWrite(docs.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })));
  }
  console.log(`imported ${docs.length} answers`);
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
