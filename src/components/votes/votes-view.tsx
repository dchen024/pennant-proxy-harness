"use client";

import { Fragment } from "react";
import Link from "next/link";
import { ModeBadge, modeLabel } from "@/components/mode-badge";
import { VOTE_ITEM_LABEL, VoteBadge } from "@/components/policy-view";
import { modelName, shortModel } from "@/lib/format";
import type { Mode, ModelSummary, Vote, VoteItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { columnScore, decisionFor, ITEMS, type RunVotes } from "./compute";

export interface VoteColumn {
  model: string;
  mode: Mode;
  key: string;
}

/** Which vote the explanation sheet shows: a model column (colKey) or the answer key ("key"). */
export interface VoteSelection {
  ticker: string;
  item: VoteItem;
  col: string;
}

type Mismatch = { ticker: string; item: VoteItem; vote: Vote; ref: Vote };

/**
 * One column's vote tally. Wrong = a FOR/AGAINST that differs from the answer key (a silent error);
 * escalated = REVIEW where the key decided (a human looks). Counts come from the graded run summary
 * when it has them, else from the votes computed here; the places always come from the votes here.
 */
interface Tally {
  match: number;
  total: number;
  wrong: number;
  escalated: number;
  wrongAt: Mismatch[];
  escalatedAt: Mismatch[];
}

function tally(c: VoteColumn, votes: RunVotes, summary?: ModelSummary[]): Tally {
  const s = columnScore(votes.byColumn.get(c.key) ?? new Map());
  const wrongAt = s.mismatches.filter((m) => m.vote !== "REVIEW");
  const escalatedAt = s.mismatches.filter((m) => m.vote === "REVIEW");
  const row = summary?.find((x) => x.model === c.model && x.mode === c.mode);
  if (row && row.votesTotal > 0 && row.votesWrong !== undefined && row.votesEscalated !== undefined) {
    return { match: row.votesCorrect, total: row.votesTotal, wrong: row.votesWrong, escalated: row.votesEscalated, wrongAt, escalatedAt };
  }
  return { match: s.match, total: s.total, wrong: wrongAt.length, escalated: escalatedAt.length, wrongAt, escalatedAt };
}

const place = (m: Mismatch) => `${m.ticker} ${VOTE_ITEM_LABEL[m.item].toLowerCase()}`;
/** " (AAPL say-on-pay: FOR where the key says AGAINST)" — only when the places agree with the count. */
const wrongPlaces = (t: Tally) =>
  t.wrongAt.length === t.wrong && t.wrong > 0
    ? ` (${t.wrongAt.map((m) => `${place(m)}: ${m.vote} where the key says ${m.ref}`).join("; ")})`
    : "";
const escalatedPlaces = (t: Tally) =>
  t.escalatedAt.length === t.escalated && t.escalated > 0 ? ` (${t.escalatedAt.map(place).join(", ")})` : "";

function describeTally(t: Tally): string {
  const n = t.wrong + t.escalated;
  if (n === 0) return "no mismatches.";
  if (t.wrong === 0) {
    const lead = n === 1 ? "the one mismatch is escalated to REVIEW" : `${n === 2 ? "both" : `all ${n}`} mismatches are escalated to REVIEW`;
    return `${lead}${escalatedPlaces(t)}; ${n === 1 ? "it is not" : "none is"} a wrong FOR/AGAINST.`;
  }
  const parts = [
    `${t.wrong} wrong FOR/AGAINST${wrongPlaces(t)}`,
    t.escalated ? `${t.escalated} escalated to REVIEW${escalatedPlaces(t)}` : null,
  ].filter(Boolean);
  return `${n} mismatch${n === 1 ? "" : "es"}: ${parts.join("; ")}.`;
}

const signature = (t: Tally) =>
  [t.match, t.total, t.wrong, t.escalated, ...[...t.wrongAt, ...t.escalatedAt].map((m) => `${m.ticker}.${m.item}.${m.vote}.${m.ref}`)].join("|");

/** Header lines: per mode, how many votes each model gets right, and how many misses are wrong vs escalated. */
export function VoteSummary({ columns, votes, summary }: { columns: VoteColumn[]; votes: RunVotes; summary?: ModelSummary[] }) {
  const modes = [...new Set(columns.map((c) => c.mode))];
  return (
    <div className="space-y-1 text-[12.5px]" data-vote-summary>
      {modes.map((mode) => {
        const tallies = columns.filter((c) => c.mode === mode).map((c) => ({ c, t: tally(c, votes, summary) }));
        if (tallies.length === 0) return null;
        const first = tallies[0].t;
        const same = tallies.every((x) => signature(x.t) === signature(first));
        return (
          <p key={mode} className="flex flex-wrap items-baseline gap-x-1.5" data-vote-summary-mode={mode}>
            <ModeBadge mode={mode} className="self-center" />
            {same ? (
              <span>
                <span className="font-medium">
                  {tallies.length > 1 ? "Every model" : modelName(tallies[0].c.model)}: {first.match}/{first.total} votes match the
                  answer key
                </span>
                ; {describeTally(first)}
              </span>
            ) : (
              <span>
                {tallies.map(({ c, t }, i) => (
                  <Fragment key={c.key}>
                    {i > 0 ? " · " : null}
                    <span data-vote-tally={c.key}>
                      <span className="font-medium">{modelName(c.model)}</span> {t.match}/{t.total}
                      {t.wrong || t.escalated ? ": " : null}
                      {t.wrong ? (
                        <span className="text-red-700">
                          <span className="font-medium">{t.wrong} wrong</span>
                          {wrongPlaces(t)}
                        </span>
                      ) : null}
                      {t.wrong && t.escalated ? ", " : null}
                      {t.escalated ? <span className="text-muted-foreground">{t.escalated} escalated</span> : null}
                    </span>
                  </Fragment>
                ))}
                .
              </span>
            )}
          </p>
        );
      })}
    </div>
  );
}

export function VotesMatrix({
  columns,
  tickers,
  companies,
  votes,
  mismatchesOnly,
  selected,
  onOpen,
}: {
  columns: VoteColumn[];
  tickers: string[];
  companies: Map<string, string>;
  votes: RunVotes;
  mismatchesOnly: boolean;
  selected: VoteSelection | null;
  onOpen: (sel: VoteSelection) => void;
}) {
  const scoreByCol = new Map(columns.map((c) => [c.key, columnScore(votes.byColumn.get(c.key) ?? new Map())]));

  const rowMismatch = (ticker: string, item: VoteItem) =>
    columns.some((c) => {
      const tv = votes.byColumn.get(c.key)?.get(ticker);
      return tv?.graded && decisionFor(tv.model, item).vote !== decisionFor(tv.ref, item).vote;
    });

  return (
    <div className="w-fit max-w-full overflow-auto rounded-lg border bg-card" style={{ maxHeight: "calc(100vh - 260px)" }}>
      <table className="border-separate border-spacing-0 text-[12px]" data-votes-matrix>
        <thead>
          <tr>
            <th className="sticky top-0 left-0 z-30 min-w-[230px] border-r border-b bg-card px-3 py-2 text-left align-bottom text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Company · ballot item
            </th>
            <th className="sticky top-0 z-20 min-w-[96px] border-r border-b bg-muted/60 px-2 py-2 text-left align-bottom text-[11px] font-medium tracking-wide text-muted-foreground uppercase backdrop-blur">
              Answer key
            </th>
            {columns.map((c) => {
              const s = scoreByCol.get(c.key);
              return (
                <th key={c.key} className="sticky top-0 z-20 min-w-[104px] border-b bg-card/95 px-1.5 py-2 text-left align-bottom font-normal backdrop-blur">
                  <div className="truncate font-mono text-[11px] font-medium" title={c.model}>
                    {shortModel(c.model)}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <ModeBadge mode={c.mode} short />
                    <span
                      className={cn("font-mono text-[10.5px] tabular-nums", s && s.match < s.total ? "text-red-700" : "text-muted-foreground")}
                      title="votes matching the answer key"
                    >
                      {s ? `${s.match}/${s.total}` : "—"}
                    </span>
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {tickers.map((ticker) => {
            const items = ITEMS.filter((item) => !mismatchesOnly || rowMismatch(ticker, item));
            if (items.length === 0) return null;
            const key = votes.answerKey.get(ticker);
            return (
              <Fragment key={ticker}>
                <tr>
                  <td colSpan={2 + columns.length} className="sticky left-0 border-b bg-muted/70 px-3 py-1.5 text-[12px]">
                    <Link href={`/companies/${ticker}`} className="font-mono font-semibold hover:underline">
                      {ticker}
                    </Link>
                    <span className="ml-2 text-muted-foreground">{companies.get(ticker) ?? ""}</span>
                  </td>
                </tr>
                {items.map((item) => {
                  const keyVote = key ? decisionFor(key.evaluation, item).vote : null;
                  return (
                    <tr key={item} className="group">
                      <td className="sticky left-0 z-10 border-r border-b bg-card px-3 py-1.5 group-hover:bg-muted/40">
                        {VOTE_ITEM_LABEL[item]}
                      </td>
                      <td className="border-r border-b bg-muted/30 px-1.5 py-1">
                        {keyVote ? (
                          <VoteCell
                            vote={keyVote}
                            mismatch={false}
                            label={`Answer key, ${ticker} ${VOTE_ITEM_LABEL[item]}: ${keyVote}`}
                            active={selected?.ticker === ticker && selected.item === item && selected.col === "key"}
                            onClick={() => onOpen({ ticker, item, col: "key" })}
                            data={`key:${ticker}:${item}`}
                          />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      {columns.map((c) => {
                        const tv = votes.byColumn.get(c.key)?.get(ticker);
                        if (!tv || tv.results.size === 0) {
                          return (
                            <td key={c.key} className="border-b px-1.5 py-1">
                              <div className="h-7 rounded border border-dashed border-neutral-200" title="pending" />
                            </td>
                          );
                        }
                        const vote = decisionFor(tv.model, item).vote;
                        const ref = decisionFor(tv.ref, item).vote;
                        const mismatch = tv.graded && vote !== ref;
                        return (
                          <td key={c.key} className="border-b px-1.5 py-1">
                            <VoteCell
                              vote={vote}
                              mismatch={mismatch}
                              label={`${modelName(c.model)} (${modeLabel(c.mode)}), ${ticker} ${VOTE_ITEM_LABEL[item]}: ${vote}${mismatch ? `, differs from the answer key (${ref})` : ""}`}
                              active={selected?.ticker === ticker && selected.item === item && selected.col === c.key}
                              onClick={() => onOpen({ ticker, item, col: c.key })}
                              data={`${c.key}:${ticker}:${item}`}
                            />
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
    </div>
  );
}

function VoteCell({
  vote,
  mismatch,
  label,
  active,
  onClick,
  data,
}: {
  vote: Vote;
  mismatch: boolean;
  label: string;
  active: boolean;
  onClick: () => void;
  data: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-vote-cell={data}
      data-mismatch={mismatch || undefined}
      className={cn(
        "relative flex h-7 w-full items-center justify-center rounded transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
        mismatch && "bg-red-50 ring-2 ring-red-500 ring-inset hover:bg-red-100",
        active && "ring-2 ring-foreground ring-inset",
      )}
    >
      <VoteBadge vote={vote} className="min-w-14 text-[10.5px]" />
      {mismatch ? (
        <span
          className="absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-red-600 text-[9px] leading-none font-bold text-white"
          aria-hidden
        >
          ≠
        </span>
      ) : null}
    </button>
  );
}
