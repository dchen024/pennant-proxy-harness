import "./_env";
import { resolveModels } from "@/lib/config";
import { closeDb } from "@/lib/db";
import { rerunModes, runToCompletion } from "@/lib/harness/run";
import type { FactId, Mode } from "@/lib/types";

// Usage: pnpm harness [--profile dev|demo] [--models a,b] [--modes e2e,oracle] [--tickers AAPL,MSFT]
//                     [--facts audit.audit_fees_current,...] [--grade verified|any] [--label "..."]

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const modes = (arg("modes") ?? "e2e").split(",") as Mode[];
  const progress = (done: number, total: number) => {
    if (done % 10 === 0 || done === total) process.stdout.write(`\r${done}/${total} facts`);
  };
  const rerun = arg("rerun");
  const run = rerun ? await rerunModes(rerun, modes, progress) : await runToCompletion(
    {
      models: resolveModels({ profile: arg("profile"), models: arg("models") }),
      modes,
      tickers: arg("tickers")?.split(","),
      factIds: arg("facts")?.split(",") as FactId[] | undefined,
      gradeWith: (arg("grade") as "verified" | "any") ?? "verified",
      label: arg("label"),
      parserVersion: arg("parser"),
      retrieval: arg("retrieval") as "vector" | "hybrid" | undefined,
    },
    progress,
  );
  console.log(`\n\nrun ${run._id}`);
  console.table(
    run.summary?.map((s) => ({
      model: s.model,
      mode: s.mode,
      accuracy: s.accuracy === null ? "n/a" : `${(s.accuracy * 100).toFixed(1)}% (${s.correct}/${s.graded})`,
      consequential: s.consequentialErrors,
      votes: `${s.votesCorrect}/${s.votesTotal}`,
      citations: `${(s.citationValid * 100).toFixed(0)}%`,
      malformed: s.malformed,
      stages: Object.entries(s.byStage).map(([k, v]) => `${k}:${v}`).join(" "),
      cost: `$${s.costUsd.toFixed(4)}`,
      latency: `${(s.avgLatencyMs / 1000).toFixed(1)}s`,
    })),
  );
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
