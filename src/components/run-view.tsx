"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";
import type { FilingView } from "@/components/evidence";
import { ModeBadge, ModeInfo, modeLabel } from "@/components/mode-badge";
import { ResultSheet, type GoldView, type ResultRow } from "@/components/result-sheet";
import { computeRunVotes } from "@/components/votes/compute";
import { VoteSheet } from "@/components/votes/vote-sheet";
import { VotesMatrix, VoteSummary, type VoteSelection } from "@/components/votes/votes-view";
import { VoteBadge } from "@/components/policy-view";
import { StatusDot } from "@/components/run-picker";
import { STAGE_META, StageLegend } from "@/components/stage";
import { colKey } from "@/components/stats";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { FACT_BY_ID } from "@/lib/facts";
import { formatDateTime, formatDuration, formatPct, formatValue, shortModel } from "@/lib/format";
import type { Mode, RunDoc } from "@/lib/types";
import { cn } from "@/lib/utils";

const POLL_MS = 2000;

type Column = { model: string; mode: Mode; key: string };

export function RunView({
  initialRun,
  initialResults,
  filings,
  gold,
}: {
  initialRun: RunDoc;
  initialResults: ResultRow[];
  filings: FilingView[];
  gold: GoldView[];
}) {
  const [run, setRun] = useState(initialRun);
  const [results, setResults] = useState(initialResults);
  const [pollError, setPollError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modeFilter, setModeFilter] = useState<"all" | Mode>("all");
  const [tickerFilter, setTickerFilter] = useState<string>("all");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [tab, setTab] = useState<"grid" | "votes">("grid");
  const [voteSel, setVoteSel] = useState<VoteSelection | null>(null);

  // Poll while the run is in progress.
  useEffect(() => {
    if (run.status !== "running") return;
    let live = true;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(run._id)}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { run: RunDoc; results: ResultRow[] };
        if (!live) return;
        setRun(data.run);
        setResults(data.results);
        setPollError(null);
      } catch (err) {
        if (live) setPollError(err instanceof Error ? err.message : String(err));
        // Trigger another attempt by touching state.
        if (live) setRun((r) => ({ ...r }));
      }
    }, POLL_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [run]);

  const filingByTicker = useMemo(() => new Map(filings.map((f) => [f.ticker, f])), [filings]);
  const goldById = useMemo(() => new Map(gold.map((g) => [g._id, g])), [gold]);

  const cellMap = useMemo(() => {
    const m = new Map<string, ResultRow>();
    for (const r of results) m.set(`${colKey(r.model, r.mode)}::${r.ticker}::${r.factId}`, r);
    return m;
  }, [results]);
  const byId = useMemo(() => new Map(results.map((r) => [r._id, r])), [results]);

  const modes: Mode[] = (["e2e", "oracle"] as Mode[]).filter((m) => run.modes.includes(m));
  const columns: Column[] = run.models.flatMap((model) =>
    modes
      .filter((mode) => modeFilter === "all" || mode === modeFilter)
      .map((mode) => ({ model, mode, key: colKey(model, mode) })),
  );

  const colStats = useMemo(() => {
    const s = new Map<string, { graded: number; correct: number; conseq: number; done: number }>();
    for (const r of results) {
      const k = colKey(r.model, r.mode);
      const cur = s.get(k) ?? { graded: 0, correct: 0, conseq: 0, done: 0 };
      cur.done++;
      if (r.hasGold && r.correct !== null) {
        cur.graded++;
        if (r.correct) cur.correct++;
      }
      if (r.consequential) cur.conseq++;
      s.set(k, cur);
    }
    return s;
  }, [results]);

  const tickers = run.tickers.filter((t) => tickerFilter === "all" || t === tickerFilter);
  const factIds = run.factIds;

  const rowHasError = (ticker: string, factId: string) =>
    columns.some((c) => {
      const r = cellMap.get(`${c.key}::${ticker}::${factId}`);
      return r && r.stage && r.stage !== "ok";
    });

  // Votes: evaluated by the policy engine on each model's facts and on the verified answer key.
  const votes = useMemo(
    () => computeRunVotes(results, run.models, run.modes, run.tickers),
    [results, run.models, run.modes, run.tickers],
  );
  const companies = useMemo(() => new Map(filings.map((f) => [f.ticker, f.company])), [filings]);

  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;
  const pct = run.progress.total ? (run.progress.done / run.progress.total) * 100 : 0;

  return (
    <div className="mx-auto w-full max-w-[1800px] space-y-4 px-5 py-5">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Link href={`/?run=${encodeURIComponent(run._id)}`} className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
          <ArrowLeftIcon className="size-3.5" />
          Leaderboard
        </Link>
        <div className="flex items-center gap-2">
          <StatusDot status={run.status} />
          <h1 className="text-base font-semibold tracking-tight">{run.label || run._id}</h1>
          <span className="rounded bg-muted px-1.5 py-px text-[11px] text-muted-foreground">{run.status}</span>
        </div>
        <div className="text-[12px] text-muted-foreground tabular-nums" suppressHydrationWarning>
          {formatDateTime(run.startedAt)} · {formatDuration(run.startedAt, run.finishedAt)} · {run.models.length} models ×{" "}
          {run.modes.length} modes × {run.tickers.length} filings × {run.factIds.length} facts
        </div>
        <div className="ml-auto flex min-w-[260px] items-center gap-2">
          <Progress value={pct} className="h-1.5 flex-1" />
          <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
            {run.progress.done}/{run.progress.total}
          </span>
        </div>
      </div>
      {run.error ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-900">{run.error}</div>
      ) : null}
      {pollError ? <div className="text-[11px] text-amber-700">Live update failed ({pollError}); retrying…</div> : null}

      {/* Tabs: the same run seen fact by fact, or vote by vote */}
      <div className="flex items-center gap-1 border-b" role="tablist" aria-label="Run view">
        {(
          [
            ["grid", "Results grid"],
            ["votes", "Votes"],
          ] as const
        ).map(([t, label]) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            data-run-tab={t}
            onClick={() => setTab(t)}
            className={cn(
              "-mb-px border-b-2 px-3 py-1.5 text-[13px] transition-colors",
              tab === t ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-card px-3 py-2 text-[12px]">
        {modes.length > 1 ? (
          <Segmented
            value={modeFilter}
            onChange={(v) => setModeFilter(v as "all" | Mode)}
            options={[
              { value: "all", label: "Both modes" },
              ...modes.map((m) => ({ value: m, label: modeLabel(m) })),
            ]}
          />
        ) : (
          // A single-mode run (e.g. a validation run) has nothing to switch between.
          <span className="rounded-md border px-2.5 py-1 text-muted-foreground">{modes[0] ? `${modeLabel(modes[0])} only` : "No results"}</span>
        )}
        <ModeInfo className="-ml-2" />
        <Segmented
          value={tickerFilter}
          onChange={setTickerFilter}
          options={[{ value: "all", label: "All filings" }, ...run.tickers.map((t) => ({ value: t, label: t }))]}
          mono
        />
        <label className="flex cursor-pointer items-center gap-2">
          <Switch checked={errorsOnly} onCheckedChange={setErrorsOnly} />
          {tab === "votes" ? "Mismatches only" : "Rows with errors only"}
        </label>
        {tab === "votes" ? (
          <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
            <VoteBadge vote="FOR" className="min-w-0" />
            <VoteBadge vote="AGAINST" className="min-w-0" />
            <VoteBadge vote="REVIEW" className="min-w-0" />
            <span className="inline-flex items-center gap-1">
              <span className="flex size-3.5 items-center justify-center rounded-full bg-red-600 text-[9px] font-bold text-white">≠</span>
              differs from the answer key
            </span>
          </div>
        ) : (
          <StageLegend className="ml-auto" showNoGold />
        )}
      </div>

      {tab === "votes" ? (
        <div className="space-y-3" data-votes-tab>
          <div className="rounded-lg border bg-card px-4 py-3">
            <VoteSummary columns={columns} votes={votes} />
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              The answer-key column applies the policy to the verified facts. Click any vote to see the rules, which fired,
              and every fact behind it.
            </p>
          </div>
          <VotesMatrix
            columns={columns}
            tickers={tickers}
            companies={companies}
            votes={votes}
            mismatchesOnly={errorsOnly}
            selected={voteSel}
            onOpen={setVoteSel}
          />
        </div>
      ) : null}

      {/* Grid */}
      <div
        className={cn("w-fit max-w-full overflow-auto rounded-lg border bg-card", tab !== "grid" && "hidden")}
        style={{ maxHeight: "calc(100vh - 220px)" }}
      >
        <table className="border-separate border-spacing-0 text-[12px]">
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-30 min-w-[230px] border-r border-b bg-card px-3 py-2 text-left align-bottom text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Fact
              </th>
              <th className="sticky top-0 z-20 min-w-[92px] border-r border-b bg-muted/60 px-2 py-2 text-left align-bottom text-[11px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
                Gold
              </th>
              {columns.map((c) => {
                const st = colStats.get(c.key);
                return (
                  <th
                    key={c.key}
                    className="sticky top-0 z-20 min-w-[96px] border-b bg-card/95 px-1.5 py-2 text-left align-bottom font-normal backdrop-blur"
                  >
                    <div className="truncate font-mono text-[11px] font-medium" title={c.model}>
                      {shortModel(c.model)}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5">
                      <ModeBadge mode={c.mode} short />
                      <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground" title="accuracy on graded facts">
                        {st?.graded ? formatPct(st.correct / st.graded, 0) : "—"}
                      </span>
                      {st?.conseq ? (
                        <span className="font-mono text-[10.5px] text-red-700" title="consequential errors">
                          ⚠{st.conseq}
                        </span>
                      ) : null}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {tickers.map((ticker) => {
              const filing = filingByTicker.get(ticker);
              const visible = factIds.filter((f) => !errorsOnly || rowHasError(ticker, f));
              if (errorsOnly && visible.length === 0) return null;
              return (
                <Fragment key={ticker}>
                  <tr>
                    <td
                      colSpan={2 + columns.length}
                      className="sticky left-0 border-b bg-muted/70 px-3 py-1.5 text-[12px]"
                    >
                      <Link href={`/companies/${ticker}`} className="font-mono font-semibold hover:underline">
                        {ticker}
                      </Link>
                      <span className="ml-2 text-muted-foreground">{filing?.company ?? ""}</span>
                    </td>
                  </tr>
                  {visible.map((factId) => {
                    const def = FACT_BY_ID[factId];
                    const g = goldById.get(`${ticker}:${factId}`);
                    return (
                      <tr key={factId} className="group">
                        <td className="sticky left-0 z-10 border-r border-b bg-card px-3 py-1 group-hover:bg-muted/40">
                          <div className="truncate text-[12px]" title={def?.description}>
                            {def?.label ?? factId}
                          </div>
                        </td>
                        <td className="border-r border-b bg-muted/30 px-2 py-1 font-mono text-[11px] tabular-nums">
                          {g && g.value !== undefined ? (
                            <span className={g.status === "verified" ? "" : "text-muted-foreground"} title={`gold: ${g.status}`}>
                              {formatValue(g.value, factId, { compact: true })}
                              {g.status !== "verified" ? <span className="ml-0.5 text-[9px]">?</span> : null}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        {columns.map((c) => {
                          const r = cellMap.get(`${c.key}::${ticker}::${factId}`);
                          return (
                            <td key={c.key} className="border-b px-1 py-0.5">
                              <Cell r={r} factId={factId} onOpen={() => r && setSelectedId(r._id)} active={r?._id === selectedId} />
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {results.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-muted-foreground">
            {run.status === "running" ? "Waiting for the first results…" : "This run has no results."}
          </div>
        ) : null}
      </div>

      <VoteSheet
        sel={voteSel}
        votes={votes}
        company={voteSel ? companies.get(voteSel.ticker) : undefined}
        filing={voteSel ? filingByTicker.get(voteSel.ticker) : undefined}
        goldById={goldById}
        open={!!voteSel}
        onOpenChange={(o) => !o && setVoteSel(null)}
        onOpenFact={setSelectedId}
      />

      <ResultSheet
        result={selected}
        gold={selected ? goldById.get(`${selected.ticker}:${selected.factId}`) : undefined}
        filing={selected ? filingByTicker.get(selected.ticker) : undefined}
        open={!!selected}
        onOpenChange={(o) => !o && setSelectedId(null)}
      />
    </div>
  );
}

function Cell({
  r,
  factId,
  onOpen,
  active,
}: {
  r: ResultRow | undefined;
  factId: string;
  onOpen: () => void;
  active: boolean;
}) {
  if (!r) {
    return <div className="h-6 rounded-[3px] border border-dashed border-neutral-200" title="pending" />;
  }
  const v = r.extraction ? formatValue(r.extraction.value, factId, { compact: true }) : r.error ? "error" : "—";
  const stage = r.stage;
  const title = [
    `${shortModel(r.model)} · ${r.mode}`,
    `value: ${r.extraction ? formatValue(r.extraction.value, factId) : "none"}`,
    r.hasGold ? `gold: ${formatValue(r.gold, factId)}` : "no gold",
    stage ? `stage: ${STAGE_META[stage].label}` : null,
    r.consequential ? "CONSEQUENTIAL: flips a vote" : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <button
      type="button"
      onClick={onOpen}
      title={title}
      className={cn(
        "flex h-6 w-full items-center gap-1 rounded-[3px] border-l-[3px] px-1.5 text-left font-mono text-[11px] tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        stage ? STAGE_META[stage].cell : "border-l-transparent bg-transparent ring-1 ring-inset ring-neutral-300 hover:bg-muted",
        active && "ring-2 ring-foreground ring-inset",
      )}
    >
      {r.consequential ? <span className="text-[10px] leading-none text-red-600" aria-label="consequential">⚠</span> : null}
      <span className="truncate">{v}</span>
    </button>
  );
}

function Segmented({
  value,
  onChange,
  options,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  mono?: boolean;
}) {
  return (
    <div className="inline-flex rounded-md border p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-[5px] px-2 py-0.5 text-[12px] transition-colors",
            mono && o.value !== "all" && "font-mono text-[11px]",
            value === o.value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
