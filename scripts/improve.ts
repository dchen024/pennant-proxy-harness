import "./_env";
import { closeDb } from "@/lib/db";
import { approveProposal, listProposals, proposeImprovements, refreshValidation, rejectProposal, revertProposal } from "@/lib/improve/loop";

// pnpm improve propose [--run <runId>]   the agent proposes changes from a graded run (about $0.10)
// pnpm improve list                      proposals and their status / validation verdicts
// pnpm improve approve <id>              human approval: new config + validation run (about $0.05)
// pnpm improve reject <id>
// pnpm improve revert <id> "<why>"      human revert of the newest kept change
async function main() {
  const [cmd, id] = process.argv.slice(2);
  const ri = process.argv.indexOf("--run");
  if (cmd === "propose") {
    const docs = await proposeImprovements(ri > -1 ? process.argv[ri + 1] : "run_20260926183801_qo2q");
    for (const p of docs) {
      console.log(`\n${p._id}  [${p.kind} → ${p.target}]  fixes: ${p.fixes.join(", ")}`);
      if (p.before) console.log(`  before: ${p.before}`);
      console.log(`  after:  ${p.after}\n  why:    ${p.rationale}\n  risk:   ${p.risk}`);
    }
  } else if (cmd === "approve") {
    const r = await approveProposal(id, { wait: true });
    const p = await refreshValidation(id);
    console.log(`approved ${id} → ${r.configId}, validation run ${r.runId}`);
    console.log(JSON.stringify(p?.report, null, 2));
  } else if (cmd === "revert") {
    const note = process.argv[4] ?? "Reverted by a human reviewer.";
    const active = await revertProposal(id, note);
    console.log(`reverted ${id}; active config is now ${active?._id ?? "the base configuration"}`);
  } else if (cmd === "reject") {
    await rejectProposal(id);
    console.log(`rejected ${id}`);
  } else {
    for (const p of await listProposals())
      console.log(`${p._id}  ${p.status.padEnd(9)} ${p.kind} → ${p.target}${p.report ? `  (${p.report.verdict}: ${p.report.reason})` : ""}`);
  }
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
