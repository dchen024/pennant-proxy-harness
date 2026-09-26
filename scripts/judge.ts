import "./_env";
import pLimit from "p-limit";
import { z } from "zod";
import { closeDb, collections, getDb } from "@/lib/db";
import { FACT_BY_ID } from "@/lib/facts";
import { chatJSON } from "@/lib/openrouter";
import type { FactId, FactValue } from "@/lib/types";

// LLM-as-judge: audits each answer against the passages the model saw. Needs no answer key, so it
// also works on new filings; here it is scored against the human-verified key.
// Usage: pnpm judge [--run <runId>] [--models a,b] [--judge <model>]

const arg = (n: string) => (process.argv.indexOf(`--${n}`) > -1 ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined);

const SYSTEM = `You audit fact extractions from SEC proxy statements for an institutional investor's voting team.
You get a fact definition, the excerpts the extraction model saw, and its answer (value, cited excerpt, quote).
Verdicts:
- correct: the cited excerpt supports this value for this fact definition (right fiscal year, person, table and units).
- incorrect: the value is wrong given the excerpts. Give the correct value if the excerpts show it.
- missed: the model answered null, but the excerpts contain the answer or let you derive it. Give it.
- not_in_context: the model answered null and the excerpts really don't contain or imply the answer.
Answer in one sentence of reasoning. Return only JSON.`;

const Verdict = z.object({
  verdict: z.enum(["correct", "incorrect", "missed", "not_in_context"]),
  correct_value: z.union([z.number(), z.boolean()]).nullable(),
  reason: z.string(),
});
const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["correct", "incorrect", "missed", "not_in_context"] },
    correct_value: { type: ["number", "boolean", "null"] },
    reason: { type: "string" },
  },
  required: ["verdict", "correct_value", "reason"],
};

export interface Judgment {
  _id: string; // result id
  runId: string;
  model: string;
  ticker: string;
  factId: FactId;
  judgeModel: string;
  verdict: z.infer<typeof Verdict>["verdict"];
  correctValue: FactValue;
  reason: string;
  goldCorrect: boolean | null;
  costUsd: number | null;
  createdAt: string;
}

async function main() {
  const c = await collections();
  const judgments = (await getDb()).collection<Judgment>("judgments");
  const runId = arg("run") ?? "run_20260926183801_qo2q";
  const models = (arg("models") ?? "openai/gpt-6-sol,openai/gpt-6-luna").split(",");
  const judgeModel = arg("judge") ?? "deepseek/deepseek-v4.1-flash";
  const results = await c.results.find({ runId, mode: "e2e", model: { $in: models } }).toArray();
  const chunkIds = [...new Set(results.flatMap((r) => r.retrievedChunkIds))];
  const chunks = new Map((await c.chunks.find({ _id: { $in: chunkIds } }, { projection: { embedding: 0 } }).toArray()).map((ch) => [ch._id, ch]));
  const companies = new Map((await c.filings.find({}).toArray()).map((f) => [f._id, f.company]));

  let cost = 0;
  const limit = pLimit(8);
  await Promise.all(
    results.map((r) =>
      limit(async () => {
        const fact = FACT_BY_ID[r.factId];
        const excerpts = r.retrievedChunkIds
          .map((id) => chunks.get(id))
          .filter(Boolean)
          .map((ch) => `<excerpt id="${ch!._id}" page="${ch!.page}">\n${ch!.context ? `<preceding_text>\n${ch!.context}\n</preceding_text>\n` : ""}${ch!.text}\n</excerpt>`)
          .join("\n\n");
        const answer = r.extraction
          ? `value: ${JSON.stringify(r.extraction.value)}\ncited excerpt: ${r.extraction.chunkId}\nquote: ${JSON.stringify(r.extraction.quote)}\nfiscal_year: ${r.extraction.fiscalYear}`
          : `no valid answer (${r.error ?? "malformed output"})`;
        const user = `Company: ${companies.get(r.ticker)} (${r.ticker})\nFact: ${fact.label}\nDefinition: ${fact.description}\nAnswer type: ${fact.type}${fact.unit ? ` (${fact.unit})` : ""}\n\nExcerpts the model saw:\n${excerpts}\n\nThe model's answer:\n${answer}`;
        const res = await chatJSON({ model: judgeModel, system: SYSTEM, user, schema: Verdict, jsonSchema: VERDICT_SCHEMA, schemaName: "judgment", maxTokens: 2000 });
        cost += res.costUsd ?? 0;
        if (!res.data) return;
        await judgments.replaceOne(
          { _id: r._id },
          {
            runId, model: r.model, ticker: r.ticker, factId: r.factId, judgeModel,
            verdict: res.data.verdict, correctValue: res.data.correct_value, reason: res.data.reason,
            goldCorrect: r.correct, costUsd: res.costUsd, createdAt: new Date().toISOString(),
          },
          { upsert: true },
        );
      }),
    ),
  );

  // Score the judge against the human-verified key.
  const js = await judgments.find({ runId, model: { $in: models }, judgeModel }).toArray();
  const flagged = (j: Judgment) => j.verdict === "incorrect" || j.verdict === "missed";
  const wrong = js.filter((j) => j.goldCorrect === false);
  const right = js.filter((j) => j.goldCorrect === true);
  console.log(`\njudge ${judgeModel} on ${js.length} answers (${models.join(", ")}), cost $${cost.toFixed(4)}`);
  console.log(`  wrong answers (per answer key): ${wrong.length}`);
  console.log(`    flagged as incorrect/missed:  ${wrong.filter(flagged).length}`);
  console.log(`    judged "not in context":      ${wrong.filter((j) => j.verdict === "not_in_context").length}   (a search miss, correctly blamed on missing context)`);
  console.log(`    judged "correct" (missed):    ${wrong.filter((j) => j.verdict === "correct").length}`);
  console.log(`  right answers: ${right.length}`);
  console.log(`    false alarms:                 ${right.filter(flagged).length}`);
  for (const j of js.filter((x) => flagged(x) || x.goldCorrect === false))
    console.log(`  ${j.goldCorrect ? "FALSE ALARM" : "real error "} ${j.model.split("/")[1]} ${j.ticker}:${j.factId} → ${j.verdict}${j.correctValue !== null ? ` (says ${j.correctValue})` : ""}: ${j.reason.slice(0, 150)}`);
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
