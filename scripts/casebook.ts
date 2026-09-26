import "./_env";
import fs from "node:fs/promises";
import { closeDb, collections } from "@/lib/db";
import { FACT_BY_ID } from "@/lib/facts";
import type { FactId, FactResult, FactValue } from "@/lib/types";

// The casebook: real traps and failures from graded runs, kept as a regression set.
//   pnpm casebook                 build data/casebook.json from the answer key + every graded run
//   pnpm casebook --check <runId> score a run against the casebook (no model calls)

type Trap = "wrong-table" | "wrong-column" | "two-passages" | "absence" | "definition" | "glyph" | "retrieval";

// Traps found by hand while building the answer key and reading failures.
const TRAPS: Record<string, { traps: Trap[]; note: string }> = {
  "JPM:pay.ceo_total_comp_current": {
    traps: ["wrong-table"],
    note: "JPM's own 'annual compensation' table shows $43,000,000; the SEC Summary Compensation Table (p. 76) says $40,632,724.",
  },
  "JPM:pay.ceo_total_comp_prior": {
    traps: ["wrong-table"],
    note: "Same two tables for the prior year: $39,000,000 (performance-year view) vs $37,683,462 (SEC SCT).",
  },
  "META:pay.peer_tsr_current": {
    traps: ["wrong-column"],
    note: "Company TSR (243.32) sits next to peer-group TSR (445.33) in the pay-versus-performance table.",
  },
  "AAPL:board.independent_nominee_count": {
    traps: ["two-passages"],
    note: "7 = 'the Board's eight nominees' (p. 65) minus Mr. Cook ('all Board members, other than Mr. Cook, are independent', p. 18).",
  },
  "JPM:board.independent_nominee_count": {
    traps: ["two-passages"],
    note: "10 = 11 nominees, 'all independent other than our CEO' (one sentence, p. 12; formal determination on p. 27).",
  },
  "META:board.independent_nominee_count": {
    traps: ["glyph"],
    note: "Independence is marked with Wingdings checkmarks that extract as U+F0FC; invisible to models until mapped to ✓.",
  },
  "JPM:audit.all_other_fees_current": {
    traps: ["absence"],
    note: "No 'All other fees' row: the rows (91.0 + 38.1 + 5.9) sum to the total (135.0), so the answer is $0.",
  },
  "JPM:audit.audit_related_fees_current": {
    traps: ["retrieval"],
    note: "Keyword search ranks JPM's fee descriptions above the fee table; the table says 'Audit-related', not 'Audit-related fees'.",
  },
  "AAPL:governance.unequal_voting_sunset": { traps: ["absence"], note: "Single class of stock: nothing to sunset." },
  "GOOGL:governance.unequal_voting_sunset": {
    traps: ["absence"],
    note: "Class B has 10 votes; conversion only at the holder's option (p. 37). The only 'sunset' text is a shareholder asking for one.",
  },
  "META:governance.unequal_voting_sunset": {
    traps: ["absence"],
    note: "Dual class with no sunset; the board opposes the proposal to end it (p. 76).",
  },
  "AAPL:board.has_lead_independent_director": {
    traps: ["definition"],
    note: "Independent Chair (Levinson), no lead director role: false under the definition.",
  },
  "GOOGL:board.has_lead_independent_director": {
    traps: ["definition"],
    note: "Independent Chair (Hennessy), no lead director role: false under the definition.",
  },
  "MSFT:pay.company_tsr_current": {
    traps: ["retrieval"],
    note: "The pay-versus-performance table's title lands in a different chunk from its rows (fixed by parser v3 heading context).",
  },
};

interface Observation {
  runId: string;
  run: string;
  model: string;
  mode: string;
  got: FactValue;
  stage: string | null;
  correct: boolean | null;
}

interface Case {
  id: string;
  ticker: string;
  factId: FactId;
  label: string;
  expected: FactValue;
  evidence: { page: number | null; quote: string | null; chunkId: string | null };
  traps: Trap[];
  note: string;
  observed: Observation[];
  failures: number;
}

async function build() {
  const c = await collections();
  const gold = await c.gold.find({ status: "verified" }).toArray();
  const runs = await c.runs.find({ status: "done" }).toArray();
  const results = await c.results.find({ runId: { $in: runs.map((r) => r._id) }, hasGold: true }).toArray();
  const byFact = new Map<string, FactResult[]>();
  for (const r of results) byFact.set(`${r.ticker}:${r.factId}`, [...(byFact.get(`${r.ticker}:${r.factId}`) ?? []), r]);

  const cases: Case[] = [];
  for (const g of gold) {
    const observed = (byFact.get(g._id) ?? []).map((r) => ({
      runId: r.runId,
      run: runs.find((x) => x._id === r.runId)?.label ?? r.runId,
      model: r.model,
      mode: r.mode === "oracle" ? "reading only" : "full pipeline",
      got: r.extraction?.value ?? null,
      stage: r.stage,
      correct: r.correct,
    }));
    const failures = observed.filter((o) => !o.correct).length;
    const tagged = TRAPS[g._id];
    if (!tagged && failures === 0) continue;
    cases.push({
      id: g._id,
      ticker: g.ticker,
      factId: g.factId,
      label: FACT_BY_ID[g.factId].label,
      expected: g.value,
      evidence: { page: g.page, quote: g.quote, chunkId: g.chunkId },
      traps: tagged?.traps ?? ["retrieval"],
      note: tagged?.note ?? "Failed in at least one graded run; see observed.",
      observed,
      failures,
    });
  }
  cases.sort((a, b) => b.failures - a.failures || a.id.localeCompare(b.id));
  await fs.writeFile("data/casebook.json", JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2));
  console.log(`casebook: ${cases.length} cases → data/casebook.json`);
  console.table(cases.map((k) => ({ case: k.id, traps: k.traps.join(","), expected: JSON.stringify(k.expected), failures: `${k.failures}/${k.observed.length}` })));
}

async function check(runId: string) {
  const { cases } = JSON.parse(await fs.readFile("data/casebook.json", "utf8")) as { cases: Case[] };
  const c = await collections();
  const results = await c.results.find({ runId, hasGold: true }).toArray();
  const models = [...new Set(results.map((r) => `${r.model}|${r.mode}`))];
  const rows = cases.map((k) => {
    const row: Record<string, string> = { case: k.id, trap: k.traps.join(",") };
    for (const m of models) {
      const [model, mode] = m.split("|");
      const r = results.find((x) => x.model === model && x.mode === mode && `${x.ticker}:${x.factId}` === k.id);
      row[`${model.split("/")[1]}${mode === "oracle" ? " (reading)" : ""}`] = r ? (r.correct ? "pass" : `FAIL:${r.stage}`) : "—";
    }
    return row;
  });
  console.table(rows);
  for (const m of models) {
    const [model, mode] = m.split("|");
    const mine = results.filter((x) => x.model === model && x.mode === mode && cases.some((k) => k.id === `${x.ticker}:${x.factId}`));
    console.log(`${model} (${mode === "oracle" ? "reading only" : "full pipeline"}): ${mine.filter((x) => x.correct).length}/${mine.length} cases pass`);
  }
}

async function main() {
  const i = process.argv.indexOf("--check");
  if (i > -1) await check(process.argv[i + 1]);
  else await build();
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
