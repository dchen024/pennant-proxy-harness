import "./_env";
import { closeDb, collections } from "@/lib/db";
import { FACT_IDS, type FactId, type Policy } from "@/lib/types";
import { compilePolicy } from "@/lib/policy/compile";
import { compareTrees } from "@/lib/policy/equivalence";
import { factsInExpr, VOTE_ITEMS } from "@/lib/policy/evaluate";
import { formatRule } from "@/lib/policy/format";
import { GOLD_POLICY, POLICY_TEXT } from "@/lib/policy/policy";

// Usage: pnpm policy:compile [--model anthropic/claude-opus-5.5]
// Compiles POLICY_TEXT with an LLM, checks it against GOLD_POLICY by random testing, stores it if MONGODB_URI is set.

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Facts the given items' rules read, in either policy (keeps disagreement examples short). */
function factsForItems(items: Set<string>, ...policies: Policy[]): FactId[] {
  const used = new Set(policies.flatMap((p) => p.rules.filter((r) => items.has(r.item)).flatMap((r) => factsInExpr(r.when))));
  return FACT_IDS.filter((f) => used.has(f));
}

async function main() {
  const model = arg("model") ?? "anthropic/claude-opus-5.5";
  console.log(`Compiling POLICY_TEXT with ${model} ...`);
  const res = await compilePolicy(POLICY_TEXT, model);
  const cost = res.costUsd === null ? "n/a" : `$${res.costUsd.toFixed(4)}`;
  console.log(`latency ${(res.latencyMs / 1000).toFixed(1)}s, cost ${cost}, schema ${res.schemaVariant ?? "n/a"}`);

  if (res.errors.length > 0) {
    console.log(`\nValidation errors (${res.errors.length}):`);
    for (const e of res.errors) console.log(`  - ${e}`);
  } else {
    console.log("\nValidation: no errors");
  }

  const policy = res.policy;
  if (!policy) {
    console.log("\nCompilation FAILED. Raw output (first 2000 chars):\n" + res.raw.slice(0, 2000));
    process.exitCode = 1;
    return;
  }

  console.log(`\nCompiled "${policy.name}" (${policy.rules.length} rules):`);
  for (const r of policy.rules) console.log(`  ${formatRule(r)}`);

  const eq = compareTrees(policy, GOLD_POLICY);
  console.log(`\nEquivalence vs GOLD_POLICY over ${eq.samples} random fact sets (incl. exact ties and missing facts):`);
  console.log(`  ${"all items".padEnd(14)} ${pct(eq.agreement)}`);
  for (const item of VOTE_ITEMS) console.log(`  ${item.padEnd(14)} ${pct(eq.byItem[item])}`);

  if (eq.disagreements.length === 0) {
    console.log("  no disagreements");
  } else {
    console.log(`\nDisagreements (showing ${Math.min(3, eq.disagreements.length)}):`);
    for (const d of eq.disagreements.slice(0, 3)) {
      const differing = VOTE_ITEMS.filter((_, i) => d.a[i] !== d.b[i]);
      console.log(`  ${differing.map((item) => `${item}: compiled ${d.a[VOTE_ITEMS.indexOf(item)]} vs gold ${d.b[VOTE_ITEMS.indexOf(item)]}`).join("; ")}`);
      for (const f of factsForItems(new Set(differing), policy, GOLD_POLICY)) {
        console.log(`      ${f} = ${JSON.stringify(d.facts[f] ?? null)}`);
      }
    }
  }

  if (process.env.MONGODB_URI) {
    const id = `compiled:${model}:${Date.now()}`;
    const { policies } = await collections();
    await policies.insertOne({ ...policy, id, _id: id, compiledBy: model, createdAt: new Date().toISOString() });
    console.log(`\nStored policy ${id}`);
  } else {
    console.log("\nMONGODB_URI not set; compiled policy not stored.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
