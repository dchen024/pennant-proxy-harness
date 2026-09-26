"use client";

import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { ModeBadge, ModeInfo } from "@/components/mode-badge";
import { StageBar, STAGE_META, STAGE_ORDER } from "@/components/stage";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCost, formatInt, formatMs, formatPct, modelName, shortModel } from "@/lib/format";
import type { Mode, ModelSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { accuracyRanks, escalatedVotes, rowKey, wrongVotes, type SortKey, type SortState } from "./rank";

const COLS: { key: SortKey | null; label: string; hint?: string; className?: string }[] = [
  { key: null, label: "#", hint: "Rank by accuracy (correct ÷ graded) within the mode. “=” marks a tie.", className: "w-10 pr-0" },
  { key: "model", label: "Model", hint: "Exact model id underneath; every result is attributable to one model." },
  { key: "accuracy", label: "Accuracy", hint: "Share of facts with a verified gold answer that the model got right." },
  { key: "graded", label: "Graded", hint: "Correct / graded facts. Facts without a gold answer are not graded." },
  {
    key: "consequential",
    label: "Vote-flipping",
    hint: "Wrong facts that change at least one vote under the policy. These are the errors that matter.",
  },
  {
    key: "votes",
    label: "Votes",
    hint: "Votes (nominating/governance chair, say-on-pay, auditor) that match the votes from the verified answers. “n escalated” counts REVIEW votes where the answer key decided: a human looks at those, so they are not silent errors.",
  },
  {
    key: "wrongVotes",
    label: "Wrong votes",
    hint: "A FOR/AGAINST that differs from the answer key: a silent error. Escalations to REVIEW are not counted here.",
  },
  {
    key: "citations",
    label: "Citations",
    hint: "Share of answered facts whose citation checks all pass: quote in the cited chunk, value in the quote, page matches the evidence.",
  },
  { key: "malformed", label: "Malformed", hint: "Outputs that could not be parsed into the schema, even after one repair attempt." },
  { key: "cost", label: "Cost", hint: "Total OpenRouter cost for this model in this mode, and cost per proxy statement." },
  { key: "latency", label: "Latency", hint: "Mean wall-clock latency per fact." },
  {
    key: null,
    label: "Error attribution",
    hint: "Every fact is attributed to the first pipeline stage that went wrong: parse, retrieval, extraction, citation, format or API.",
    className: "w-[140px]",
  },
];

function HeaderCell({
  col,
  sort,
  onSort,
}: {
  col: (typeof COLS)[number];
  sort: SortState;
  onSort: (key: SortKey) => void;
}) {
  const active = col.key !== null && sort.key === col.key;
  // The label is the sort button and the definition tooltip; only the active column shows an arrow.
  const label = (
    <span className={cn(col.hint && "underline decoration-dotted decoration-from-font underline-offset-[3px]")}>{col.label}</span>
  );
  const trigger = col.key ? (
    <button
      type="button"
      data-sort={col.key}
      onClick={() => onSort(col.key!)}
      className={cn(
        "inline-flex cursor-pointer items-center gap-0.5 uppercase transition-colors hover:text-foreground",
        active && "text-foreground",
      )}
    >
      {label}
      {active ? (
        sort.dir === "asc" ? (
          <ArrowUpIcon className="size-3" aria-label="ascending" />
        ) : (
          <ArrowDownIcon className="size-3" aria-label="descending" />
        )
      ) : null}
    </button>
  ) : (
    <span tabIndex={col.hint ? 0 : undefined} className="cursor-help outline-none">
      {label}
    </span>
  );
  return (
    <th
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
      className={cn(
        "h-9 px-2.5 text-left align-middle text-[11px] font-medium tracking-wide whitespace-nowrap text-muted-foreground uppercase",
        col.className,
      )}
    >
      {col.hint ? (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent className="max-w-64 tracking-normal normal-case">
            {col.hint}
            {col.key ? " Click to sort." : ""}
          </TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
    </th>
  );
}

export interface ModeGroup {
  mode: Mode;
  rows: ModelSummary[];
}

export function ModelsTable({
  groups,
  grouped,
  sort,
  onSort,
  filings,
}: {
  groups: ModeGroup[];
  /** Show a subheader per mode (the "Both" view). */
  grouped: boolean;
  sort: SortState;
  onSort: (key: SortKey) => void;
  filings: number;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]" data-models-table>
        <thead className="border-b bg-muted/40">
          <tr>
            {COLS.map((c) => (
              <HeaderCell key={c.label} col={c} sort={sort} onSort={onSort} />
            ))}
          </tr>
        </thead>
        {groups.map((g) => (
          <Group key={g.mode} group={g} grouped={grouped} filings={filings} />
        ))}
      </table>
    </div>
  );
}

function Group({ group, grouped, filings }: { group: ModeGroup; grouped: boolean; filings: number }) {
  const ranks = accuracyRanks(group.rows);
  const bestRank = group.rows.some((r) => ranks.get(rowKey(r))?.rank === 1);
  const fewestConseq = Math.min(...group.rows.map((r) => r.consequentialErrors));
  const cheapest = Math.min(...group.rows.filter((r) => r.costUsd > 0).map((r) => r.costUsd));
  return (
    <tbody data-mode-group={group.mode}>
      {grouped ? (
        <tr className="border-b bg-muted/60">
          <td colSpan={COLS.length} className="px-3 py-1.5 text-[11.5px]">
            <span className="inline-flex items-center gap-2">
              <ModeBadge mode={group.mode} />
              <span className="text-muted-foreground">
                {group.rows.length} model{group.rows.length === 1 ? "" : "s"} · same run, same facts
              </span>
              <ModeInfo />
            </span>
          </td>
        </tr>
      ) : null}
      {group.rows.map((r) => {
        const rk = ranks.get(rowKey(r));
        const tied = (rk?.tiedWith.length ?? 0) > 0;
        const stageTotal = STAGE_ORDER.reduce((s, k) => s + (r.byStage[k] ?? 0), 0);
        const wrong = wrongVotes(r);
        const esc = escalatedVotes(r);
        return (
          <tr key={rowKey(r)} className="border-b last:border-b-0 hover:bg-muted/30" data-row={rowKey(r)}>
            <td
              className="px-2.5 py-2 pr-0 align-middle font-mono text-[11px] whitespace-nowrap text-muted-foreground tabular-nums"
              title={tied ? `Tied with ${rk!.tiedWith.map((o) => modelName(o.model)).join(", ")}` : undefined}
              data-rank
            >
              {rk?.rank ? `${rk.rank}${tied ? "=" : ""}` : "—"}
            </td>
            <td className="px-2.5 py-2 align-middle">
              <div className="font-medium whitespace-nowrap">{modelName(r.model)}</div>
              <div className="font-mono text-[10.5px] whitespace-nowrap text-muted-foreground" title={r.model}>
                {shortModel(r.model)}
              </div>
            </td>
            <td className="px-2.5 py-2 align-middle">
              <span className={cn("font-mono text-[14px] tabular-nums", bestRank && rk?.rank === 1 && "font-semibold")}>
                {formatPct(r.accuracy)}
              </span>
            </td>
            <td className="px-2.5 py-2 align-middle font-mono whitespace-nowrap text-muted-foreground tabular-nums">
              <span className="text-foreground">{formatInt(r.correct)}</span>/{formatInt(r.graded)}
              {r.facts > r.graded ? <span className="ml-1 text-[11px]">({r.facts - r.graded} ungraded)</span> : null}
            </td>
            <td className="px-2.5 py-2 align-middle">
              <span
                className={cn(
                  "inline-flex min-w-7 justify-center rounded px-1.5 py-px font-mono tabular-nums",
                  r.consequentialErrors > 0 ? "bg-red-50 text-red-800 ring-1 ring-red-600/20 ring-inset" : "text-emerald-700",
                  r.consequentialErrors === fewestConseq && "font-semibold",
                )}
              >
                {r.consequentialErrors}
              </span>
            </td>
            <td className="px-2.5 py-2 align-middle whitespace-nowrap" data-votes>
              {r.votesTotal > 0 ? (
                <>
                  <div className="font-mono tabular-nums">
                    {r.votesCorrect}
                    <span className="text-muted-foreground">/{r.votesTotal}</span>
                  </div>
                  {esc ? <div className="text-[10.5px] text-muted-foreground tabular-nums">{esc} escalated</div> : null}
                </>
              ) : (
                <span className="font-mono text-muted-foreground">—</span>
              )}
            </td>
            <td className="px-2.5 py-2 align-middle" data-wrong-votes>
              {wrong === null ? (
                <span className="font-mono text-muted-foreground">—</span>
              ) : (
                <span
                  className={cn(
                    "inline-flex min-w-7 justify-center rounded px-1.5 py-px font-mono tabular-nums",
                    wrong > 0 ? "bg-red-50 font-semibold text-red-800 ring-1 ring-red-600/20 ring-inset" : "text-emerald-700",
                  )}
                >
                  {wrong}
                </span>
              )}
            </td>
            <td className="px-2.5 py-2 align-middle font-mono tabular-nums">{formatPct(r.citationValid, 0)}</td>
            <td className="px-2.5 py-2 align-middle font-mono tabular-nums">
              <span className={r.malformed > 0 ? "text-foreground" : "text-muted-foreground"}>{r.malformed}</span>
            </td>
            <td className="px-2.5 py-2 align-middle whitespace-nowrap">
              <div className={cn("font-mono tabular-nums", r.costUsd === cheapest && "font-semibold")}>{formatCost(r.costUsd)}</div>
              {filings > 1 ? (
                <div className="font-mono text-[11px] text-muted-foreground tabular-nums">{formatCost(r.costUsd / filings)}/filing</div>
              ) : null}
            </td>
            <td className="px-2.5 py-2 align-middle font-mono whitespace-nowrap tabular-nums">{formatMs(r.avgLatencyMs)}</td>
            <td className="px-2.5 py-2 align-middle">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="cursor-default py-1">
                    <StageBar byStage={r.byStage} height={10} />
                  </div>
                </TooltipTrigger>
                <TooltipContent className="block">
                  <div className="space-y-0.5">
                    {STAGE_ORDER.filter((k) => r.byStage[k]).map((k) => (
                      <div key={k} className="flex items-center gap-2 tabular-nums">
                        <span className="inline-block h-0.5 w-3" style={{ background: STAGE_META[k].color }} />
                        <span className="font-semibold">{r.byStage[k]}</span>
                        <span className="opacity-80">{STAGE_META[k].label}</span>
                        <span className="ml-auto pl-3 opacity-60">
                          {stageTotal ? formatPct((r.byStage[k] ?? 0) / stageTotal, 0) : ""}
                        </span>
                      </div>
                    ))}
                    {stageTotal === 0 ? <div>No graded facts yet</div> : null}
                  </div>
                </TooltipContent>
              </Tooltip>
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}
