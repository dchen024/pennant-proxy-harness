import Link from "next/link";
import { ExternalLinkIcon } from "lucide-react";
import { DbBanner, EmptyState } from "@/components/empty-state";
import { ModeBadge, ModeInfo } from "@/components/mode-badge";
import { DecisionRow, RuleCard } from "@/components/policy-view";
import { STAGE_META } from "@/components/stage";
import { COMPANIES } from "@/lib/companies";
import { FACTS } from "@/lib/facts";
import { formatQuote, formatValue, shortModel } from "@/lib/format";
import { evaluatePolicy } from "@/lib/policy/evaluate";
import { GOLD_POLICY } from "@/lib/policy/policy";
import { getDbStatus, getDefaultRun, getFiling, getResults, listGold, listRuns } from "@/lib/queries";
import type { FactMap } from "@/lib/types";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: PageProps<"/companies/[ticker]">) {
  const { ticker } = await props.params;
  return { title: `${ticker.toUpperCase()} · Proxy Harness` };
}

export default async function CompanyPage(props: PageProps<"/companies/[ticker]">) {
  const { ticker: raw } = await props.params;
  const ticker = raw.toUpperCase();
  const known = COMPANIES.find((c) => c.ticker === ticker);
  const status = await getDbStatus();

  const [filing, gold, runs] = status.ok
    ? await Promise.all([getFiling(ticker), listGold(ticker), listRuns(20)])
    : [null, [], []];
  const run = await getDefaultRun(runs);
  const results = run ? (await getResults(run._id)).filter((r) => r.ticker === ticker) : [];

  const goldById = new Map(gold.map((g) => [g.factId, g]));
  const facts: FactMap = {};
  for (const g of gold) if (g.status !== "disputed") facts[g.factId] = g.value;
  const evaluation = gold.length ? evaluatePolicy(GOLD_POLICY, facts) : null;

  const columns = run
    ? run.models.flatMap((m) => run.modes.map((mode) => ({ model: m, mode, key: `${m}::${mode}` })))
    : [];
  const cell = new Map(results.map((r) => [`${r.model}::${r.mode}::${r.factId}`, r]));

  const company = filing?.company ?? known?.company ?? ticker;

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-5 px-5 py-6">
      <DbBanner status={status} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="font-mono text-[12px] text-muted-foreground">{ticker}</div>
          <h1 className="text-lg font-semibold tracking-tight">{company}</h1>
          {filing ? (
            <p className="text-[12px] text-muted-foreground">
              {filing.form} filed {filing.filingDate} · accession <span className="font-mono">{filing.accession}</span> ·{" "}
              {filing.pages.length} pages
            </p>
          ) : null}
        </div>
        {filing ? (
          <div className="flex gap-2 text-[12px]">
            <a href={filing.pdfPath} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 hover:bg-muted">
              PDF <ExternalLinkIcon className="size-3" />
            </a>
            <a href={filing.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 hover:bg-muted">
              EDGAR source <ExternalLinkIcon className="size-3" />
            </a>
          </div>
        ) : null}
      </div>

      {!filing && status.ok ? (
        <EmptyState title={`No filing ingested for ${ticker}`} commands={[{ cmd: "pnpm filings" }, { cmd: "pnpm ingest" }]} />
      ) : null}

      {evaluation ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <section className="rounded-lg border bg-card">
            <div className="border-b px-4 py-2.5">
              <h2 className="text-[13px] font-semibold">Reference votes</h2>
              <p className="text-[11px] text-muted-foreground">The policy applied to the answer-key facts below.</p>
            </div>
            <div className="space-y-2 px-4 py-3">
              {evaluation.decisions.map((d) => (
                <DecisionRow key={d.item} d={d} />
              ))}
            </div>
          </section>
          <section className="rounded-lg border bg-card">
            <div className="border-b px-4 py-2.5">
              <h2 className="text-[13px] font-semibold">Rules with this company&apos;s facts</h2>
            </div>
            <div className="grid grid-cols-1 gap-2 p-3 xl:grid-cols-2">
              {GOLD_POLICY.rules.map((r) => (
                <RuleCard key={r.id} rule={r} evaluation={evaluation.rules.find((e) => e.ruleId === r.id)} />
              ))}
            </div>
          </section>
        </div>
      ) : null}

      <section className="rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <div>
            <h2 className="text-[13px] font-semibold">Facts</h2>
            <p className="text-[11px] text-muted-foreground">
              Answer key with evidence{run ? ` · model answers from ${run.label || run._id}` : ""}. Cell colour = error stage.{" "}
              {columns.length ? <ModeInfo /> : null}
            </p>
          </div>
          <Link href="/review" className="text-[12px] text-muted-foreground hover:text-foreground hover:underline">
            Review answer key →
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="border-b bg-muted/40 text-[11px] text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium uppercase tracking-wide">Fact</th>
                <th className="px-3 py-2 text-left font-medium uppercase tracking-wide">Answer key</th>
                <th className="px-3 py-2 text-left font-medium uppercase tracking-wide">Evidence</th>
                {columns.map((c) => (
                  <th key={c.key} className="px-1.5 py-2 text-left font-normal">
                    <div className="font-mono text-[10.5px] font-medium text-foreground">{shortModel(c.model)}</div>
                    <ModeBadge mode={c.mode} short className="mt-0.5" />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {FACTS.map((f) => {
                const g = goldById.get(f.id);
                return (
                  <tr key={f.id} className="border-b last:border-b-0">
                    <td className="px-3 py-1.5" title={f.description}>
                      {f.label}
                    </td>
                    <td className="px-3 py-1.5 font-mono tabular-nums">
                      {g ? (
                        <span className="inline-flex items-center gap-1.5">
                          {formatValue(g.value, f.id)}
                          <span
                            className={cn(
                              "rounded px-1 text-[10px] font-sans",
                              g.status === "verified" && "bg-emerald-50 text-emerald-800",
                              g.status === "disputed" && "bg-red-50 text-red-800",
                              g.status === "proposed" && "bg-amber-50 text-amber-900",
                            )}
                          >
                            {g.status}
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="max-w-[360px] px-3 py-1.5">
                      {g?.page && filing ? (
                        <a
                          href={`${filing.pdfPath}#page=${g.page}`}
                          target="_blank"
                          rel="noreferrer"
                          className="block truncate text-muted-foreground hover:text-foreground"
                          title={g.quote ?? undefined}
                        >
                          <span className="font-mono text-foreground">p.{g.page}</span> {g.quote ? `“${formatQuote(g.quote)}”` : ""}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    {columns.map((c) => {
                      const r = cell.get(`${c.key}::${f.id}`);
                      return (
                        <td key={c.key} className="px-1 py-0.5">
                          {r ? (
                            <div
                              className={cn(
                                "flex h-6 items-center gap-1 rounded-[3px] border-l-[3px] px-1.5 font-mono text-[11px] tabular-nums",
                                r.stage ? STAGE_META[r.stage].cell : "border-l-transparent ring-1 ring-inset ring-neutral-300",
                              )}
                              title={r.stage ? STAGE_META[r.stage].label : "no gold"}
                            >
                              {r.consequential ? <span className="text-[10px] text-red-600">⚠</span> : null}
                              <span className="truncate">
                                {r.extraction ? formatValue(r.extraction.value, f.id, { compact: true }) : "—"}
                              </span>
                            </div>
                          ) : (
                            <div className="h-6 rounded-[3px] border border-dashed border-neutral-200" />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {run ? (
          <div className="border-t px-4 py-2 text-[11px] text-muted-foreground">
            Open the{" "}
            <Link href={`/runs/${encodeURIComponent(run._id)}`} className="underline">
              results grid
            </Link>{" "}
            for citations and PDF evidence of each answer.
          </div>
        ) : null}
      </section>
    </div>
  );
}
