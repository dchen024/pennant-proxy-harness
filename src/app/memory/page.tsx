import fs from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon, CheckIcon, RotateCcwIcon } from "lucide-react";
import { DbBanner } from "@/components/empty-state";
import { WordDiff } from "@/components/improve/word-diff";
import { collections, getDb } from "@/lib/db";
import { FACT_BY_ID } from "@/lib/facts";
import { formatDateTime, modelName, shortModel } from "@/lib/format";
import { getDbStatus } from "@/lib/queries";
import type { ConfigDoc, FactId, ProposalKind } from "@/lib/types";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Memory · Proxy Harness" };

interface LessonDoc {
  _id: string;
  factId: FactId;
  scope: string;
  terms: string[];
  learnedFrom: string[];
  motivatedBy: string[];
  adopted: boolean;
}
interface JudgmentDoc {
  _id: string;
  runId: string;
  model: string;
  ticker: string;
  factId: FactId;
  judgeModel: string;
  verdict: string;
  reason: string;
  goldCorrect: boolean;
}
interface CasebookCase {
  id: string;
  ticker: string;
  factId: string;
  label: string;
  traps: string[];
  note: string;
  failures: number;
  observed: unknown[];
}

const KIND: Record<ProposalKind, { label: string; cls: string }> = {
  prompt_rule: { label: "Prompt rule", cls: "bg-violet-50 text-violet-800 ring-violet-600/20" },
  fact_definition: { label: "Fact definition", cls: "bg-sky-50 text-sky-800 ring-sky-600/20" },
  retrieval_query: { label: "Search query", cls: "bg-teal-50 text-teal-800 ring-teal-600/20" },
};

const TRAP: Record<string, string> = {
  retrieval: "Search doesn’t surface the passage",
  absence: "The answer is an absence (no sunset, no fee)",
  "two-passages": "Needs two passages combined",
  "wrong-table": "A look-alike table elsewhere in the filing",
  definition: "Hinges on a definition",
  "wrong-column": "Wrong column or year in the right table",
  glyph: "Symbol glyphs in the PDF text",
};

const factLabel = (id: string) => (id === "system" ? "Extraction prompt" : (FACT_BY_ID[id as FactId]?.label ?? id));
const CURATED = "human/curated-evidence";

async function load() {
  const c = await collections();
  const db = await getDb();
  const [configs, proposals, lessons, judgments, gold, runs] = await Promise.all([
    c.configs.find({}).sort({ createdAt: 1 }).toArray(),
    c.proposals.find({}).sort({ createdAt: 1 }).toArray(),
    db.collection<LessonDoc>("lessons").find({ scope: "all" }).toArray(),
    db.collection<JudgmentDoc>("judgments").find({}).toArray(),
    c.gold.find({}, { projection: { status: 1, evidenceBy: 1, chunkId: 1, proposals: 1 } }).toArray(),
    c.runs.find({}, { projection: { label: 1 } }).toArray(),
  ]);
  return { configs, proposals, lessons, judgments, gold, runLabel: new Map(runs.map((r) => [r._id, r.label ?? r._id])) };
}

export default async function MemoryPage() {
  const status = await getDbStatus();
  if (!status.ok) {
    return (
      <div className="mx-auto w-full max-w-[1200px] space-y-5 px-5 py-6">
        <DbBanner status={status} />
      </div>
    );
  }
  const { configs, proposals, lessons, judgments, gold, runLabel } = await load();
  let casebook: CasebookCase[] = [];
  try {
    casebook = (JSON.parse(await fs.readFile(path.join(process.cwd(), "data/casebook.json"), "utf8")) as { cases: CasebookCase[] }).cases;
  } catch {
    casebook = [];
  }

  // Active lineage: the config of the latest kept proposal, followed back through its parents.
  const byConfig = new Map(configs.map((cfg) => [cfg._id, cfg]));
  const kept = proposals.filter((p) => p.status === "kept" && p.configId).sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""));
  const lineage: ConfigDoc[] = [];
  for (let cur = kept[0]?.configId ? byConfig.get(kept[0].configId) : undefined; cur; cur = cur.parent ? byConfig.get(cur.parent) : undefined) {
    lineage.unshift(cur);
  }
  const proposalFor = (cfgId: string) => proposals.find((p) => p.configId === cfgId);
  const notKept = proposals.filter((p) => p.status === "rejected" || p.status === "reverted");

  // Judge scored against the answer key.
  const verdictCounts = judgments.reduce<Record<string, number>>((a, j) => ((a[j.verdict] = (a[j.verdict] ?? 0) + 1), a), {});
  const rightAnswers = judgments.filter((j) => j.goldCorrect);
  const falseAlarms = rightAnswers.filter((j) => j.verdict !== "correct").length;
  const errors = judgments.filter((j) => !j.goldCorrect);
  const errorVerdicts = errors.reduce<Record<string, number>>((a, j) => ((a[j.verdict] = (a[j.verdict] ?? 0) + 1), a), {});

  // Answer-key provenance (unset evidenceBy = drafting model; curated passages that predate the field are recognised by their proposal).
  const verified = gold.filter((g) => g.status === "verified");
  const provenance = { draft: 0, curated: 0, reviewer: 0 };
  let inferredCurated = 0;
  for (const g of verified) {
    if (g.evidenceBy === "reviewer") provenance.reviewer++;
    else if (g.evidenceBy === "curated") provenance.curated++;
    else if (!g.evidenceBy && g.chunkId && g.proposals?.some((p) => p.model === CURATED && p.chunkId === g.chunkId)) {
      provenance.curated++;
      inferredCurated++;
    } else provenance.draft++;
  }

  const traps = [...new Set(casebook.flatMap((cs) => cs.traps))]
    .map((t) => ({ trap: t, cases: casebook.filter((cs) => cs.traps.includes(t)).sort((a, b) => b.failures - a.failures) }))
    .sort((a, b) => b.cases.length - a.cases.length);

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-6 px-5 py-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">What the harness has learned</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Everything the harness learns lives in MongoDB: versioned configs, proposals and their validation evidence, lessons,
          judge verdicts, the casebook and the human-verified answer key.
        </p>
        <nav className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
          {[
            ["#lineage", "Active configuration"],
            ["#not-kept", "Rejected or reverted"],
            ["#lessons", "Retrieval lessons"],
            ["#judge", "Judge findings"],
            ["#casebook", "Casebook"],
            ["#answer-key", "Answer key"],
          ].map(([href, label]) => (
            <a key={href} href={href} className="hover:text-foreground hover:underline">
              {label}
            </a>
          ))}
        </nav>
      </div>

      {/* a. Lineage */}
      <Card id="lineage" title="Active configuration" sub={lineage.length ? `${lineage.map((c) => c._id).join(" → ")} (active: ${lineage[lineage.length - 1]._id})` : "Base configuration"}>
        {lineage.length === 0 ? (
          <Empty>No change has been kept yet; runs use the original prompt, fact definitions and search queries.</Empty>
        ) : (
          <ol className="relative ml-2 space-y-5 border-l pl-6" data-lineage>
            {lineage.map((cfg, i) => {
              const p = proposalFor(cfg._id);
              const r = p?.report;
              return (
                <li key={cfg._id} className="relative" data-config={cfg._id}>
                  <span className="absolute top-1 -left-[31px] flex size-3.5 items-center justify-center rounded-full bg-emerald-600 ring-4 ring-background" />
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="font-mono text-[13px] font-semibold">{cfg._id}</span>
                    <span className="text-[12px] text-muted-foreground">built on {cfg.parent ?? "the base configuration"}</span>
                    {i === lineage.length - 1 ? (
                      <span className="rounded bg-emerald-50 px-1.5 py-px text-[10.5px] font-medium text-emerald-800 ring-1 ring-emerald-600/25 ring-inset">active</span>
                    ) : null}
                  </div>
                  {p ? (
                    <div className="mt-2 space-y-2 rounded-md border bg-card px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={cn("rounded px-1.5 py-px text-[10.5px] font-medium ring-1 ring-inset", KIND[p.kind].cls)}>{KIND[p.kind].label}</span>
                        <span className="text-[13px] font-medium">{factLabel(p.target)}</span>
                        <span className="text-[11.5px] text-muted-foreground">
                          approved by a human · {p.decidedAt ? formatDateTime(p.decidedAt) : "—"}
                        </span>
                      </div>
                      <WordDiff before={p.before} after={p.after} className="rounded bg-muted/30 px-2.5 py-1.5 text-[12px]" />
                      {r ? (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]" data-evidence>
                          <span className={cn("inline-flex items-center gap-1 font-medium", r.verdict === "keep" ? "text-emerald-700" : "text-red-700")}>
                            {r.verdict === "keep" ? <CheckIcon className="size-3.5" /> : <RotateCcwIcon className="size-3.5" />}
                            {r.verdict === "keep" ? "Kept" : "Reverted"}
                          </span>
                          <span className="text-muted-foreground">
                            vs{" "}
                            <Link href={`/runs/${encodeURIComponent(r.baselineRunId)}`} className="underline decoration-dotted underline-offset-2 hover:text-foreground">
                              {runLabel.get(r.baselineRunId) ?? r.baselineRunId}
                            </Link>
                          </span>
                          <span className="font-mono tabular-nums">
                            <span className="text-emerald-700">+{r.gained.length} gained</span> · <span className={r.lost.length ? "text-red-700" : ""}>{r.lost.length} lost</span> ·{" "}
                            <span className="text-muted-foreground">{r.noise?.length ?? 0} noise</span>
                          </span>
                          <span className="text-muted-foreground">
                            {r.perModel.map((m) => `${shortModel(m.model)} ${m.before}→${m.after}/${m.graded}`).join(" · ")}
                          </span>
                          <span className="ml-auto flex gap-3">
                            <Link href={`/improve#${p._id}`} className="inline-flex items-center gap-1 hover:underline">
                              Proposal <ArrowRightIcon className="size-3" />
                            </Link>
                            <Link href={`/runs/${encodeURIComponent(r.validationRunId)}`} className="inline-flex items-center gap-1 hover:underline">
                              Validation run <ArrowRightIcon className="size-3" />
                            </Link>
                          </span>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      {/* b. Not kept */}
      <Card id="not-kept" title="Rejected or reverted" sub={`${notKept.length} proposal${notKept.length === 1 ? "" : "s"}`}>
        {notKept.length === 0 ? (
          <Empty>None so far: every approved change was kept, and nothing was rejected.</Empty>
        ) : (
          <ul className="space-y-3 text-[12.5px]">
            {notKept.map((p) => {
              // A revert note means a human reverted a change the validation had kept.
              const human = p.status === "reverted" && !!p.revertNote;
              return (
                <li key={p._id} className="space-y-1.5" data-not-kept={p._id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn("rounded px-1.5 py-px text-[10.5px] font-medium ring-1 ring-inset", KIND[p.kind].cls)}>{KIND[p.kind].label}</span>
                    <span className="font-medium">{factLabel(p.target)}</span>
                    {p.configId ? <span className="font-mono text-[11px] text-muted-foreground">{p.configId}</span> : null}
                    <span
                      className={cn(
                        "rounded px-1.5 py-px text-[11px]",
                        human ? "bg-red-50 font-medium text-red-800 ring-1 ring-red-600/20 ring-inset" : "bg-muted",
                      )}
                    >
                      {human ? "reverted by a human" : p.status}
                    </span>
                    {human && p.decidedAt ? <span className="text-[11.5px] text-muted-foreground">{formatDateTime(p.decidedAt)}</span> : null}
                    {!human ? <span className="text-muted-foreground">{p.report?.reason ?? ""}</span> : null}
                    <Link href={`/improve#${p._id}`} className="ml-auto text-[12px] hover:underline">
                      Details →
                    </Link>
                  </div>
                  {human ? (
                    <>
                      <p className="border-l-2 border-red-300 pl-3 leading-relaxed whitespace-pre-line" data-revert-note>
                        {p.revertNote}
                      </p>
                      {p.report ? (
                        <p className="pl-3 text-[11.5px] text-muted-foreground">
                          Its validation run had kept it: {p.report.reason}
                        </p>
                      ) : null}
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* c. Lessons */}
      <Card id="lessons" title="Retrieval lessons" sub={`${lessons.length} learned search terms, one set per fact`}>
        <p className="mb-3 rounded-md bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
          Learned automatically from verified evidence; evaluated leave-one-company-out: no lessons 81.4% → naive 80.0% → gated
          81.4% recall@8 — not adopted.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]" data-lessons>
            <thead className="border-b text-[10.5px] tracking-wide text-muted-foreground uppercase">
              <tr>
                <th className="py-1.5 text-left font-medium">Fact</th>
                <th className="py-1.5 text-left font-medium">Learned terms</th>
                <th className="py-1.5 text-left font-medium">Passed the gate</th>
                <th className="py-1.5 text-left font-medium">Learned from</th>
                <th className="py-1.5 text-left font-medium">Motivated by</th>
              </tr>
            </thead>
            <tbody>
              {lessons
                .sort((a, b) => Object.keys(FACT_BY_ID).indexOf(a.factId) - Object.keys(FACT_BY_ID).indexOf(b.factId))
                .map((l) => (
                  <tr key={l._id} className="border-b align-top last:border-b-0">
                    <td className="py-1.5 pr-3 whitespace-nowrap">{factLabel(l.factId)}</td>
                    <td className="py-1.5 pr-3">
                      <span className="flex flex-wrap gap-1">
                        {l.terms.map((t) => (
                          <span key={t} className="rounded bg-muted px-1.5 py-px font-mono text-[11px]">
                            {t}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3">{l.adopted ? <span className="text-emerald-700">yes</span> : <span className="text-muted-foreground">no</span>}</td>
                    <td className="py-1.5 pr-3 font-mono text-[11px] whitespace-nowrap">{l.learnedFrom.join(" ")}</td>
                    <td className="py-1.5 text-[11px] text-muted-foreground">{l.motivatedBy.length ? l.motivatedBy.join(", ") : "—"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* d. Judge */}
      <Card id="judge" title="Judge findings" sub={`${judgments.length} answers judged by ${[...new Set(judgments.map((j) => shortModel(j.judgeModel)))].join(", ") || "—"}`}>
        <div className="mb-3 flex flex-wrap gap-2 text-[12px]" data-judge-counts>
          {Object.entries(verdictCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([v, n]) => (
              <span key={v} className="rounded border px-2 py-0.5">
                <span className="font-mono font-semibold tabular-nums">{n}</span> {v.replace(/_/g, " ")}
              </span>
            ))}
        </div>
        <p className="mb-3 text-[12.5px]" data-judge-score>
          Scored against the answer key: {falseAlarms === 0 ? "no false alarms" : `${falseAlarms} false alarm${falseAlarms === 1 ? "" : "s"}`} on{" "}
          {rightAnswers.length} correct answers;{" "}
          {Object.keys(errorVerdicts).length === 1
            ? `all ${errors.length} errors diagnosed “${Object.keys(errorVerdicts)[0].replace(/_/g, " ")}”.`
            : `${errors.length} errors diagnosed as ${Object.entries(errorVerdicts)
                .map(([v, n]) => `${n} “${v.replace(/_/g, " ")}”`)
                .join(", ")}.`}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]" data-judge-errors>
            <thead className="border-b text-[10.5px] tracking-wide text-muted-foreground uppercase">
              <tr>
                <th className="py-1.5 text-left font-medium">Company · fact</th>
                <th className="py-1.5 text-left font-medium">Model</th>
                <th className="py-1.5 text-left font-medium">Diagnosis</th>
                <th className="py-1.5 text-left font-medium">Judge’s reason</th>
              </tr>
            </thead>
            <tbody>
              {errors.map((j) => (
                <tr key={j._id} className="border-b align-top last:border-b-0">
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    <Link href={`/companies/${j.ticker}`} className="font-mono font-semibold hover:underline">
                      {j.ticker}
                    </Link>{" "}
                    {factLabel(j.factId)}
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{modelName(j.model)}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{j.verdict.replace(/_/g, " ")}</td>
                  <td className="py-1.5 text-muted-foreground">{j.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* e. Casebook */}
      <Card id="casebook" title="Casebook" sub={`${casebook.length} hard cases, grouped by the trap that makes them hard`}>
        {casebook.length === 0 ? (
          <Empty>No casebook yet (data/casebook.json).</Empty>
        ) : (
          <div className="grid gap-4 md:grid-cols-2" data-casebook>
            {traps.map(({ trap, cases }) => (
              <div key={trap}>
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="text-[12.5px] font-semibold">{TRAP[trap] ?? trap}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {trap} · {cases.length}
                  </span>
                </div>
                <ul className="space-y-1 text-[12px]">
                  {cases.map((cs) => (
                    <li key={cs.id} className="flex items-baseline gap-2" title={cs.note}>
                      <Link href={`/companies/${cs.ticker}`} className="font-mono font-semibold hover:underline">
                        {cs.ticker}
                      </Link>
                      <span className="min-w-0 flex-1 truncate">{cs.label}</span>
                      <span className="font-mono text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">
                        {cs.failures}/{cs.observed.length} failed
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* f. Answer key */}
      <Card id="answer-key" title="Answer key provenance" sub={`${verified.length} of ${gold.length} facts verified by a human`}>
        <div className="flex flex-wrap gap-2 text-[12.5px]" data-provenance>
          <Stat n={provenance.draft} label="evidence chosen by a drafting model" />
          <Stat n={provenance.curated} label="curated evidence" />
          <Stat n={provenance.reviewer} label="chosen by the reviewer in the citation editor" />
        </div>
        {inferredCurated ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            {inferredCurated} curated passage{inferredCurated === 1 ? "" : "s"} predate the evidence-provenance field and are recognised by
            their curated proposal.
          </p>
        ) : null}
        <p className="mt-2 text-[12px]">
          <Link href="/review" className="hover:underline">
            Open the review tool →
          </Link>
        </p>
      </Card>
    </div>
  );
}

function Card({ id, title, sub, children }: { id: string; title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-16 rounded-lg border bg-card">
      <div className="flex flex-wrap items-baseline gap-x-3 border-b px-4 py-2.5">
        <h2 className="text-[13.5px] font-semibold">{title}</h2>
        {sub ? <span className="text-[12px] text-muted-foreground">{sub}</span> : null}
      </div>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-dashed px-3 py-4 text-center text-[12.5px] text-muted-foreground">{children}</p>;
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <span className="rounded-md border px-2.5 py-1">
      <span className="font-mono text-[14px] font-semibold tabular-nums">{n}</span> <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

