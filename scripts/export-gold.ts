import "./_env";
import fs from "node:fs/promises";
import { closeDb, collections } from "@/lib/db";

// Snapshot the answer key into the repo so it survives the hackathon sandbox. Usage: pnpm gold:export
async function main() {
  const c = await collections();
  const docs = await c.gold.find({}).sort({ ticker: 1, factId: 1 }).toArray();
  await fs.mkdir("data/gold", { recursive: true });
  await fs.writeFile("data/gold/gold.json", JSON.stringify(docs, null, 2));
  const verified = docs.filter((d) => d.status === "verified").length;
  console.log(`exported ${docs.length} answers (${verified} verified) → data/gold/gold.json`);
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
