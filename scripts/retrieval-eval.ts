import "./_env";
import { RETRIEVAL_K, type RetrievalStrategy } from "@/lib/config";
import { closeDb, collections } from "@/lib/db";
import { FACT_BY_ID } from "@/lib/facts";
import { evidenceIn } from "@/lib/harness/checks";
import { retrieve } from "@/lib/harness/retrieve";
import type { GoldFact } from "@/lib/types";

// Retrieval recall@k against the answer key, per parser version. No LLM calls.
// Usage: pnpm eval:retrieval [--parsers v2,v3] [--grade verified|any]
async function main() {
  const pi = process.argv.indexOf("--parsers");
  const parsers = pi > -1 ? process.argv[pi + 1].split(",") : ["v2", "v3"];
  const ri = process.argv.indexOf("--retrieval");
  const strategies = (ri > -1 ? process.argv[ri + 1].split(",") : ["vector"]) as RetrievalStrategy[];
  const gi = process.argv.indexOf("--grade");
  const statuses: GoldFact["status"][] = (gi > -1 ? process.argv[gi + 1] : "any") === "any" ? ["verified", "proposed"] : ["verified"];
  const c = await collections();
  const gold = (await c.gold.find({ status: { $in: statuses }, value: { $ne: null } }).toArray()).sort((a, b) => a._id.localeCompare(b._id));

  const rows: Record<string, string | number>[] = [];
  const misses: Record<string, string[]> = {};
  for (const version of parsers)
    for (const strategy of strategies) {
      const key = `${version}/${strategy}`;
      let hit = 0;
      misses[key] = [];
      for (const g of gold) {
        const context = await retrieve(g.ticker, g.factId, RETRIEVAL_K, version, strategy);
        if (evidenceIn(context, g, FACT_BY_ID[g.factId])) hit++;
        else misses[key].push(`${g.ticker}:${g.factId}`);
      }
      rows.push({ parser: version, retrieval: strategy, facts: gold.length, found: hit, [`recall@${RETRIEVAL_K}`]: `${((hit / gold.length) * 100).toFixed(1)}%` });
    }
  console.table(rows);
  for (const [v, m] of Object.entries(misses)) console.log(`\n${v} misses (${m.length}): ${m.join(", ")}`);
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
