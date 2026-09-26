import "./_env";
import { closeDb, collections } from "@/lib/db";
import { gradeRun, type GradeWith } from "@/lib/harness/run";

// Re-grade stored answers against the current answer key: no model calls, no cost.
// Usage: pnpm regrade [runId ...|--all] [--grade verified|any]
async function main() {
  const gi = process.argv.indexOf("--grade");
  const gradeWith = (gi > -1 ? process.argv[gi + 1] : "verified") as GradeWith;
  const c = await collections();
  let ids = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--grade");
  if (process.argv.includes("--all")) ids = (await c.runs.find({ status: "done" }).project({ _id: 1 }).toArray()).map((r) => r._id as string);
  if (!ids.length) ids = [(await c.runs.find({ status: "done" }).sort({ startedAt: -1 }).limit(1).next())!._id];
  for (const id of ids) {
    const run = await gradeRun(id, gradeWith);
    console.log(`\n${id} (${run.label ?? ""}, parser ${run.config.parserVersion}) graded against ${gradeWith} answers`);
    console.table(run.summary?.map((s) => ({
      model: s.model, mode: s.mode,
      accuracy: s.accuracy === null ? "n/a" : `${(s.accuracy * 100).toFixed(1)}% (${s.correct}/${s.graded})`,
      consequential: s.consequentialErrors, votes: `${s.votesCorrect}/${s.votesTotal}`,
      "wrong votes": s.votesWrong ?? 0,
      escalated: s.votesEscalated ?? 0,
      citations: `${(s.citationValid * 100).toFixed(0)}%`,
      stages: Object.entries(s.byStage).map(([k, v]) => `${k}:${v}`).join(" "),
    })));
  }
  await closeDb();
}
main().catch(async (err) => { console.error(err); await closeDb(); process.exit(1); });
