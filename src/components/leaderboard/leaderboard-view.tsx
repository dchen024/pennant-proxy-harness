"use client";

import { useMemo, useState } from "react";
import { ModeInfo, modeLabel } from "@/components/mode-badge";
import { StageLegend } from "@/components/stage";
import { formatCost, formatPct, modelName } from "@/lib/format";
import type { Mode, ModelSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AccuracyCostChart } from "./accuracy-cost-chart";
import { ModelsTable, type ModeGroup } from "./models-table";
import { DEFAULT_DIR, DEFAULT_SORT, defaultCompare, joinNames, sameAccuracy, sortRows, typicalGraded, type SortKey, type SortState } from "./rank";

type ModeChoice = Mode | "both";
const MODE_ORDER: Mode[] = ["e2e", "oracle"];

export interface RunFacts {
  models: number;
  modes: Mode[];
  filings: number;
  factsPerFiling: number;
}

/**
 * The leaderboard for one run: a single run in which every model answered every fact in each
 * mode. The mode control drives the tiles, the table and the chart together.
 */
export function LeaderboardView({
  rows,
  run,
  provisional,
  notes,
}: {
  rows: ModelSummary[];
  run: RunFacts;
  provisional?: boolean;
  /** Rendered next to the chart (e.g. "How to read this"). */
  notes?: React.ReactNode;
}) {
  const available = MODE_ORDER.filter((m) => rows.some((r) => r.mode === m));
  const [mode, setMode] = useState<ModeChoice>(available[0] ?? "e2e");
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);

  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: DEFAULT_DIR[key] }));

  const groups: ModeGroup[] = useMemo(
    () =>
      (mode === "both" ? available : [mode]).map((m) => ({ mode: m, rows: sortRows(rows.filter((r) => r.mode === m), sort) })),
    [available, mode, rows, sort],
  );

  const graded = typicalGraded(rows);
  const tiePts = graded ? Math.ceil(200 / graded) : 3;
  const tileMode: Mode = mode === "both" ? (available[0] ?? "e2e") : mode;
  const multiMode = available.length > 1;

  return (
    <div className="space-y-5">
      <p className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted-foreground" data-run-line>
        <span className="font-medium text-foreground">1 run</span>·<span>{run.models} models</span>·
        <span>
          each answered every fact{" "}
          {run.modes.length > 1
            ? `twice (${run.modes.map((m) => modeLabel(m).toLowerCase()).join(" and ")})`
            : `once (${modeLabel(run.modes[0] ?? "e2e").toLowerCase()})`}
        </span>
        {run.filings ? (
          <>
            ·
            <span>
              {run.factsPerFiling * run.filings} facts ({run.factsPerFiling} × {run.filings} filings)
            </span>
          </>
        ) : null}
        <ModeInfo />
      </p>

      <KpiTiles
        pool={rows.filter((r) => r.mode === tileMode)}
        allRows={rows}
        run={run}
        scope={multiMode ? modeLabel(tileMode).toLowerCase() : null}
        tiePts={tiePts}
      />

      <section className="rounded-lg border bg-card">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2.5">
          <h2 className="text-[13px] font-semibold">Models</h2>
          {multiMode ? (
            <div className="flex items-center gap-1.5">
              <div className="inline-flex rounded-md border p-0.5" role="radiogroup" aria-label="Mode">
                {[...available, "both" as const].map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={mode === m}
                    data-mode-choice={m}
                    onClick={() => setMode(m)}
                    className={cn(
                      "rounded-[5px] px-2.5 py-0.5 text-[12px] transition-colors",
                      mode === m ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {m === "both" ? "Both" : modeLabel(m)}
                  </button>
                ))}
              </div>
              <ModeInfo />
            </div>
          ) : null}
          <StageLegend className="ml-auto" />
        </div>
        {rows.length ? (
          <ModelsTable groups={groups} grouped={mode === "both"} sort={sort} onSort={onSort} filings={run.filings} />
        ) : (
          <div className="px-4 py-10 text-center text-[13px] text-muted-foreground">No results yet for this run.</div>
        )}
        <div className="space-y-0.5 border-t px-4 py-2 text-[11px] text-muted-foreground" data-tie-note>
          {graded ? (
            <p>
              {graded} graded facts: one fact = {(100 / graded).toFixed(1)} points; treat gaps under ~{tiePts} points as ties.
              Equal accuracy is ordered by fewer vote-flipping errors, then cost. Click a column to sort.
            </p>
          ) : null}
          {provisional ? (
            <p>Provisional: computed live from results while the run is in progress. Votes fill in when the run finishes.</p>
          ) : null}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <section className="rounded-lg border bg-card">
          <div className="border-b px-4 py-2.5">
            <h2 className="text-[13px] font-semibold">
              Accuracy vs cost{" "}
              <span className="font-normal text-muted-foreground">· {mode === "both" ? "both modes" : modeLabel(mode).toLowerCase()}</span>
            </h2>
            <p className="text-[11px] text-muted-foreground">
              Up and to the left is better. The line joins models no cheaper model beats.
            </p>
          </div>
          <div className="px-3 py-3">
            <AccuracyCostChart rows={rows} perFiling={run.filings} mode={mode} />
          </div>
        </section>
        {notes}
      </div>
    </div>
  );
}

function KpiTiles({
  pool,
  allRows,
  run,
  scope,
  tiePts,
}: {
  pool: ModelSummary[];
  allRows: ModelSummary[];
  run: RunFacts;
  scope: string | null;
  tiePts: number;
}) {
  const graded = [...pool.filter((r) => r.graded > 0)].sort(defaultCompare); // tie-break order
  if (graded.length === 0) return null;
  const best = graded[0];
  const bestAcc = best.accuracy ?? 0;
  const top = graded.filter((r) => sameAccuracy(r, best));
  const minConseq = Math.min(...graded.map((r) => r.consequentialErrors));
  const safest = graded.filter((r) => r.consequentialErrors === minConseq);
  const near = graded.filter((r) => r.costUsd > 0 && (bestAcc - (r.accuracy ?? 0)) * 100 < tiePts);
  const minCost = near.length ? Math.min(...near.map((r) => r.costUsd)) : 0;
  const cheapest = near.filter((r) => r.costUsd === minCost);
  const total = allRows.reduce((s, r) => s + r.costUsd, 0);
  const perFiling = (usd: number) => (run.filings > 0 ? usd / run.filings : usd);

  // Every tied model is named; only a full sweep collapses to "All N models".
  const names = (list: ModelSummary[]) =>
    list.length === graded.length && list.length > 2
      ? `All ${list.length} models`
      : joinNames(list.map((r) => modelName(r.model)));
  const accOf = (list: ModelSummary[]) =>
    list.every((r) => sameAccuracy(r, list[0]))
      ? `${formatPct(list[0].accuracy)}${list.length > 1 ? " each" : ""}`
      : `${formatPct(Math.min(...list.map((r) => r.accuracy ?? 0)))}–${formatPct(Math.max(...list.map((r) => r.accuracy ?? 0)))}`;
  const behind = (r: ModelSummary) => {
    const facts = Math.round(best.correct * (r.graded / best.graded) - r.correct);
    return facts <= 0 ? "tied for best" : `${facts} fact${facts === 1 ? "" : "s"} behind best`;
  };

  const tiles: { label: string; value: string; who: string; detail?: string }[] = [
    {
      label: "Most accurate",
      value: formatPct(best.accuracy),
      who: names(top),
      detail: `${best.correct}/${best.graded}${top.length > 1 ? " each · tie, listed by fewer vote-flipping errors, then cost" : ""}`,
    },
    {
      label: "Fewest vote-flipping errors",
      value: String(minConseq),
      who: names(safest),
      detail: `${accOf(safest)} accurate${safest.length > 1 && safest.length < graded.length ? " · tie, listed by accuracy, then cost" : ""}`,
    },
    {
      label: `Cheapest within ${tiePts} pts of best`,
      value: cheapest.length ? formatCost(perFiling(minCost)) : "—",
      who: cheapest.length ? names(cheapest) : "No priced model",
      detail: cheapest.length
        ? `per filing · ${formatPct(cheapest[0].accuracy)}, ${behind(cheapest[0])} · ${near.length} of ${graded.length} models are within ${tiePts} pts`
        : undefined,
    },
    {
      label: "Run cost",
      value: formatCost(total, 2),
      who: `${run.models} models × ${run.modes.length} mode${run.modes.length === 1 ? "" : "s"} × ${run.filings} filings`,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-kpis>
      {tiles.map((t) => (
        <div key={t.label} className="rounded-lg border bg-card px-4 py-3" data-kpi={t.label}>
          <div className="text-[11px] text-muted-foreground">
            {t.label}
            {scope && t.label !== "Run cost" ? <span className="opacity-70"> ({scope})</span> : null}
          </div>
          <div className="mt-1 font-mono text-xl font-semibold tracking-tight tabular-nums">{t.value}</div>
          <div className="mt-0.5 text-[11.5px] leading-snug font-medium text-foreground/90">{t.who}</div>
          {t.detail ? <div className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">{t.detail}</div> : null}
        </div>
      ))}
    </div>
  );
}
