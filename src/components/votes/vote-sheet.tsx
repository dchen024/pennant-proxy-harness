"use client";

import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import type { FilingView } from "@/components/evidence";
import { ModeBadge, ModeInfo } from "@/components/mode-badge";
import { VOTE_ITEM_LABEL, VoteBadge } from "@/components/policy-view";
import type { GoldView } from "@/components/result-sheet";
import { StageChip } from "@/components/stage";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { FACT_BY_ID } from "@/lib/facts";
import { formatQuote, formatValue, modelName } from "@/lib/format";
import { valuesMatch } from "@/lib/policy/evaluate";
import { formatExpr } from "@/lib/policy/format";
import type { FactValue, Mode, Tri } from "@/lib/types";
import { cn } from "@/lib/utils";
import { decisionFor, decisionSummary, factsForItem, firedOf, reviewReasons, rulesFor, type RunVotes } from "./compute";
import type { VoteSelection } from "./votes-view";

function TriChip({ value, who }: { value: Tri; who: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-px text-[10.5px] font-medium ring-1 ring-inset whitespace-nowrap",
        value === true && "bg-red-50 text-red-800 ring-red-600/25",
        value === false && "bg-emerald-50 text-emerald-800 ring-emerald-600/25",
        value === null && "bg-amber-50 text-amber-900 ring-amber-600/30",
      )}
    >
      <span className="font-normal opacity-70">{who}</span>
      {value === true ? "fired" : value === false ? "not fired" : "unknown"}
    </span>
  );
}

const show = (v: FactValue | undefined, factId: string, missing: string) =>
  v === null || v === undefined ? <span className="text-muted-foreground italic">{missing}</span> : formatValue(v, factId);

export function VoteSheet({
  sel,
  votes,
  company,
  filing,
  goldById,
  open,
  onOpenChange,
  onOpenFact,
}: {
  sel: VoteSelection | null;
  votes: RunVotes;
  company: string | undefined;
  filing: FilingView | undefined;
  goldById: Map<string, GoldView>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenFact: (resultId: string) => void;
}) {
  if (!sel) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full data-[side=right]:sm:max-w-[760px]" />
      </Sheet>
    );
  }

  const isKey = sel.col === "key";
  const [model, mode] = isKey ? ["", "e2e" as Mode] : (sel.col.split("::") as [string, Mode]);
  const tv = isKey ? undefined : votes.byColumn.get(sel.col)?.get(sel.ticker);
  const key = votes.answerKey.get(sel.ticker);
  const rules = rulesFor(sel.item);
  const facts = factsForItem(sel.item);

  // The comparison mirrors grading: the model's facts vs the verified answer (the model's own value where none exists).
  const mine = tv ? decisionFor(tv.model, sel.item) : key ? decisionFor(key.evaluation, sel.item) : null;
  const refEval = tv ? tv.ref : key?.evaluation;
  const ref = refEval ? decisionFor(refEval, sel.item) : null;
  const mismatch = !!tv && tv.graded && !!mine && !!ref && mine.vote !== ref.vote;
  const kind = !mismatch
    ? "match"
    : mine?.vote === "REVIEW"
      ? "escalated"
      : ref?.vote === "REVIEW"
        ? "decided"
        : "wrong";

  const reasons =
    mine?.vote === "REVIEW"
      ? tv
        ? reviewReasons(sel.item, tv.model, tv.predicted, tv.results)
        : key
          ? reviewReasons(sel.item, key.evaluation, key.facts, undefined, "the answer key has no verified value")
          : []
      : [];
  const differing =
    tv && refEval && mismatch && kind !== "escalated"
      ? rules.filter((r) => firedOf(tv.model, r.id) !== firedOf(refEval, r.id)).map((r) => r.id)
      : [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full gap-0 overflow-y-auto outline-none data-[side=right]:sm:max-w-[760px]"
        data-vote-sheet
        // Focus the panel itself on open: auto-focusing the first control (the mode ⓘ) would pop its
        // tooltip and swallow the first Esc.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <SheetHeader className="border-b px-5 pt-4 pb-3">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="font-mono font-medium text-foreground">{sel.ticker}</span>
            <span>{company}</span>
            <ChevronRightIcon className="size-3" />
            {isKey ? (
              <span className="font-medium text-foreground">Answer key (verified facts)</span>
            ) : (
              <>
                <span className="text-foreground">{modelName(model)}</span>
                <ModeBadge mode={mode} />
                <ModeInfo />
              </>
            )}
          </div>
          <SheetTitle className="text-base">{VOTE_ITEM_LABEL[sel.item]}</SheetTitle>
          <SheetDescription className="text-[12px]">
            Votes come from the policy rules below, evaluated in code on the facts. A rule that can’t be evaluated
            (a needed fact is missing) sends the item to REVIEW.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 px-5 py-4">
          {/* Vote vs answer key */}
          <div className="flex flex-wrap items-center gap-3" data-vote-compare>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground">{isKey ? "Answer key" : "This vote"}</span>
              {mine ? <VoteBadge vote={mine.vote} /> : null}
            </div>
            {!isKey && ref ? (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground">Answer key</span>
                <VoteBadge vote={ref.vote} />
              </div>
            ) : null}
            {!isKey ? (
              <span
                className={cn(
                  "rounded px-2 py-0.5 text-[12px] font-medium",
                  kind === "match" && "bg-emerald-50 text-emerald-800",
                  kind === "escalated" && "bg-amber-50 text-amber-900",
                  (kind === "wrong" || kind === "decided") && "bg-red-50 text-red-800",
                )}
                data-vote-verdict={kind}
              >
                {kind === "match"
                  ? "✓ Matches the answer key"
                  : kind === "escalated"
                    ? "≠ Escalated to REVIEW (an analyst decides); not a wrong vote"
                    : kind === "wrong"
                      ? "≠ Wrong vote"
                      : "≠ Decided where the answer key says REVIEW"}
              </span>
            ) : null}
          </div>

          {/* Plain-words explanation */}
          <div className="space-y-2 rounded-md border bg-muted/30 px-3 py-2.5 text-[12.5px] leading-relaxed" data-vote-explanation>
            {mine ? (
              <p>
                <span className="font-medium">{isKey ? "Answer key" : "This model"}:</span> {decisionSummary(sel.item, mine)}
              </p>
            ) : null}
            {reasons.length ? (
              <ul className="list-disc space-y-1 pl-5" data-review-reasons>
                {reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : null}
            {differing.length ? (
              <p>
                {differing.join(" and ")} {differing.length === 1 ? "comes" : "come"} out differently with the model’s facts than
                with the verified facts; see the facts marked ✗ below.
              </p>
            ) : null}
            {!isKey && key ? (
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">Answer key:</span> {decisionSummary(sel.item, decisionFor(key.evaluation, sel.item))}
              </p>
            ) : null}
          </div>

          {/* Rules */}
          <div>
            <div className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Rules for {VOTE_ITEM_LABEL[sel.item].toLowerCase()}
            </div>
            <div className="divide-y rounded-md border">
              {rules.map((rule) => (
                <div key={rule.id} className="space-y-1 px-3 py-2" data-rule={rule.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11.5px] font-semibold">{rule.id}</span>
                    <span className="text-[12.5px]">AGAINST if {rule.summary.replace(/\.$/, "").replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())}</span>
                    <span className="ml-auto flex gap-1.5">
                      {tv ? <TriChip value={firedOf(tv.model, rule.id)} who="Model" /> : null}
                      {key ? <TriChip value={firedOf(key.evaluation, rule.id)} who="Answer key" /> : null}
                    </span>
                  </div>
                  <code className="block font-mono text-[11px] break-words text-muted-foreground">{formatExpr(rule.when)}</code>
                </div>
              ))}
            </div>
          </div>

          {/* Facts */}
          <div>
            <div className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Facts these rules use</div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-[12px]" data-vote-facts>
                <thead className="border-b bg-muted/40 text-[10.5px] tracking-wide text-muted-foreground uppercase">
                  <tr>
                    <th className="px-2.5 py-1.5 text-left font-medium">Fact</th>
                    {!isKey ? <th className="px-2.5 py-1.5 text-left font-medium">Model</th> : null}
                    <th className="px-2.5 py-1.5 text-left font-medium">Answer key</th>
                    {!isKey ? <th className="px-2.5 py-1.5 text-left font-medium">Match</th> : null}
                    {!isKey ? <th className="px-2.5 py-1.5 text-left font-medium">Stage</th> : null}
                    <th className="px-2.5 py-1.5 text-left font-medium">Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {facts.map((f) => {
                    const r = tv?.results.get(f);
                    const g = goldById.get(`${sel.ticker}:${f}`);
                    const keyValue = key?.facts[f];
                    const modelValue = tv?.predicted[f];
                    const ok = r?.hasGold ? r.correct === true : keyValue === undefined ? null : valuesMatch(modelValue, keyValue, f);
                    return (
                      <tr key={f} className="border-b last:border-b-0 align-top" data-vote-fact={f}>
                        <td className="px-2.5 py-1.5" title={FACT_BY_ID[f]?.description}>
                          {FACT_BY_ID[f]?.label ?? f}
                        </td>
                        {!isKey ? (
                          <td className="px-2.5 py-1.5 font-mono tabular-nums">{show(modelValue, f, "not found")}</td>
                        ) : null}
                        <td className="px-2.5 py-1.5">
                          <div className="font-mono tabular-nums">{show(keyValue, f, "no answer")}</div>
                          {isKey && g?.quote ? (
                            <div className="mt-0.5 line-clamp-2 max-w-[320px] font-serif text-[11px] text-muted-foreground" title={g.quote}>
                              “{formatQuote(g.quote)}”
                            </div>
                          ) : null}
                        </td>
                        {!isKey ? (
                          <td className="px-2.5 py-1.5 font-semibold">
                            {ok === true ? <span className="text-emerald-700">✓</span> : ok === false ? <span className="text-red-700">✗</span> : "—"}
                          </td>
                        ) : null}
                        {!isKey ? (
                          <td className="px-2.5 py-1.5">{r && r.stage && r.stage !== "ok" ? <StageChip stage={r.stage} /> : null}</td>
                        ) : null}
                        <td className="px-2.5 py-1.5 whitespace-nowrap">
                          {!isKey && r ? (
                            <button
                              type="button"
                              onClick={() => onOpenFact(r._id)}
                              className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] hover:bg-muted"
                              data-open-fact={r._id}
                            >
                              Open <ChevronRightIcon className="size-3" />
                            </button>
                          ) : isKey && g?.page && filing ? (
                            <a
                              href={`${filing.pdfPath}#page=${g.page}`}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                            >
                              p. {g.page} <ExternalLinkIcon className="size-3" />
                            </a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!isKey ? (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                “Open” shows the model’s answer for that fact with its citation and the verified evidence on the PDF page.
              </p>
            ) : null}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
