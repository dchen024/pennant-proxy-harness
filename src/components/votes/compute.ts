import type { ResultRow } from "@/components/result-sheet";
import { colKey } from "@/components/stats";
import { FACT_BY_ID } from "@/lib/facts";
import { evaluatePolicy, factsInExpr, VOTE_ITEMS } from "@/lib/policy/evaluate";
import { GOLD_POLICY } from "@/lib/policy/policy";
import type { FactId, FactMap, ItemDecision, Mode, PolicyEvaluation, PolicyRule, Stage, Tri, Vote, VoteItem } from "@/lib/types";

// Votes are never re-derived here: the policy engine (evaluatePolicy + GOLD_POLICY) decides them.
// This module only assembles the fact maps the same way grading does and explains the outcome.

export const ITEMS: readonly VoteItem[] = VOTE_ITEMS;

export interface TickerVotes {
  /** The model's facts: its extracted values (null when it returned nothing). */
  predicted: FactMap;
  /** What grading compares against: the verified answer where one exists, else the model's own value. */
  reference: FactMap;
  model: PolicyEvaluation;
  ref: PolicyEvaluation;
  /** Results for this ticker by fact (for values, stages and the fact sheet). */
  results: Map<FactId, ResultRow>;
  /** Graded at all (some fact has a verified answer); ungraded tickers don't count toward votes. */
  graded: boolean;
}

export interface AnswerKeyVotes {
  facts: FactMap;
  evaluation: PolicyEvaluation;
}

export interface RunVotes {
  /** colKey(model, mode) -> ticker -> votes */
  byColumn: Map<string, Map<string, TickerVotes>>;
  /** ticker -> the verified answer key's own votes */
  answerKey: Map<string, AnswerKeyVotes>;
}

export function computeRunVotes(results: ResultRow[], models: string[], modes: Mode[], tickers: string[]): RunVotes {
  const grouped = new Map<string, ResultRow[]>();
  for (const r of results) {
    const k = `${colKey(r.model, r.mode)}::${r.ticker}`;
    const list = grouped.get(k);
    if (list) list.push(r);
    else grouped.set(k, [r]);
  }

  const byColumn = new Map<string, Map<string, TickerVotes>>();
  for (const model of models)
    for (const mode of modes) {
      const perTicker = new Map<string, TickerVotes>();
      for (const ticker of tickers) {
        const rs = grouped.get(`${colKey(model, mode)}::${ticker}`) ?? [];
        const predicted: FactMap = Object.fromEntries(rs.map((r) => [r.factId, r.extraction?.value ?? null]));
        const gold: FactMap = Object.fromEntries(rs.filter((r) => r.hasGold).map((r) => [r.factId, r.gold]));
        const reference: FactMap = { ...predicted, ...gold }; // facts without gold can't disagree
        perTicker.set(ticker, {
          predicted,
          reference,
          model: evaluatePolicy(GOLD_POLICY, predicted),
          ref: evaluatePolicy(GOLD_POLICY, reference),
          results: new Map(rs.map((r) => [r.factId, r])),
          graded: rs.some((r) => r.hasGold),
        });
      }
      byColumn.set(colKey(model, mode), perTicker);
    }

  // The answer key's own votes: the verified values stored on the graded results.
  const answerKey = new Map<string, AnswerKeyVotes>();
  for (const ticker of tickers) {
    const facts: FactMap = {};
    for (const r of results) if (r.ticker === ticker && r.hasGold && !(r.factId in facts)) facts[r.factId] = r.gold;
    answerKey.set(ticker, { facts, evaluation: evaluatePolicy(GOLD_POLICY, facts) });
  }
  return { byColumn, answerKey };
}

export const decisionFor = (e: PolicyEvaluation, item: VoteItem): ItemDecision =>
  e.decisions.find((d) => d.item === item) ?? { item, vote: "REVIEW", firedRules: [], unknownRules: [] };

export const firedOf = (e: PolicyEvaluation, ruleId: string): Tri => e.rules.find((r) => r.ruleId === ruleId)?.fired ?? null;

export const rulesFor = (item: VoteItem): PolicyRule[] => GOLD_POLICY.rules.filter((r) => r.item === item);

/** Facts the item's rules use, unique, in order of first appearance. */
export function factsForItem(item: VoteItem): FactId[] {
  return [...new Set(rulesFor(item).flatMap((r) => factsInExpr(r.when)))];
}

/** Matches / total per column, counted like grading (only graded tickers). */
export function columnScore(perTicker: Map<string, TickerVotes>): { match: number; total: number; mismatches: { ticker: string; item: VoteItem; vote: Vote; ref: Vote }[] } {
  let match = 0;
  let total = 0;
  const mismatches: { ticker: string; item: VoteItem; vote: Vote; ref: Vote }[] = [];
  for (const [ticker, tv] of perTicker) {
    if (!tv.graded) continue;
    for (const item of ITEMS) {
      total++;
      const v = decisionFor(tv.model, item).vote;
      const ref = decisionFor(tv.ref, item).vote;
      if (v === ref) match++;
      else mismatches.push({ ticker, item, vote: v, ref });
    }
  }
  return { match, total, mismatches };
}

const factLabel = (id: FactId) => (FACT_BY_ID[id]?.label ?? id).replace(/\s*\([^)]*\)\s*$/, "").toLowerCase();

export const STAGE_WHY: Partial<Record<Stage, string>> = {
  retrieval: "search never retrieved the passage that states it",
  extraction: "the passage was in the model's context, but it didn't extract the value",
  parse: "the PDF parser lost the passage",
  format: "the model's answer couldn't be parsed",
  api: "the model call failed",
  citation: "the value was right but its citation didn't hold up",
};

function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Plain-words reasons the item came out REVIEW for these facts: one line per rule that could not be
 * evaluated, naming the facts that were missing (and why, when we know the stage).
 */
export function reviewReasons(
  item: VoteItem,
  e: PolicyEvaluation,
  facts: FactMap,
  results?: Map<FactId, ResultRow>,
  missingPhrase = "the model returned “not found”",
): string[] {
  const out: string[] = [];
  for (const rule of rulesFor(item)) {
    if (firedOf(e, rule.id) !== null) continue;
    const missing = factsInExpr(rule.when).filter((f) => facts[f] === null || facts[f] === undefined);
    if (missing.length === 0) {
      out.push(`${rule.id} could not be evaluated with these values (for example, a division by zero).`);
      continue;
    }
    const why = [...new Set(missing.map((f) => results?.get(f)?.stage).filter((s): s is Stage => !!s && s !== "ok"))]
      .map((s) => STAGE_WHY[s])
      .filter(Boolean);
    out.push(
      `${rule.id} needs ${joinWords(missing.map(factLabel))}; ${missingPhrase}${missing.length > 1 ? " for " + (missing.length === 2 ? "both" : "all of them") : ""}${
        why.length ? ` (${why.join("; ")})` : ""
      }.`,
    );
  }
  return out;
}

/** One-line explanation of a decision: which rules fired, or why none did. */
export function decisionSummary(item: VoteItem, d: ItemDecision): string {
  const rules = rulesFor(item);
  if (d.vote === "AGAINST") {
    return `AGAINST via ${d.firedRules
      .map((id) => {
        const r = rules.find((x) => x.id === id);
        return r ? `${id}: ${r.summary.replace(/\.$/, "")}` : id;
      })
      .join("; ")}.`;
  }
  if (d.vote === "REVIEW") return `REVIEW: ${joinWords(d.unknownRules)} could not be evaluated, and no rule fired.`;
  return rules.length === 1 ? `FOR: ${rules[0].id} did not fire.` : `FOR: none of ${joinWords(rules.map((r) => r.id))} fired.`;
}
