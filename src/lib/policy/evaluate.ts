// Deterministic policy evaluation with Kleene three-valued logic.
// A missing/null fact is "unknown"; unknowns propagate unless the result is already decided.

import { FACT_BY_ID, FACTS } from "../facts";
import type {
  Expr,
  FactId,
  FactMap,
  FactValue,
  ItemDecision,
  Operand,
  Policy,
  PolicyEvaluation,
  RuleEvaluation,
  Tri,
  Vote,
  VoteItem,
} from "../types";

/** Ballot items in display order. Every evaluation has exactly one decision per item, in this order. */
export const VOTE_ITEMS: readonly VoteItem[] = ["nom_gov_chair", "say_on_pay", "auditor"];

export type CmpOp = Extract<Expr, { op: "cmp" }>["cmp"];
export type ArithOp = Extract<Operand, { op: string }>["op"];

/**
 * Relative tolerance for comparisons, so float noise from equivalent encodings
 * (e.g. `a / b < 2/3` vs `3 * a < 2 * b`) cannot flip a vote at an exact tie.
 */
const REL_EPS = 1e-9;

function asNumber(v: FactValue | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Numeric value of an operand; null if any input is missing/non-numeric or on division by zero. */
export function evalOperand(operand: Operand, facts: FactMap): number | null {
  if ("fact" in operand) return asNumber(facts[operand.fact]);
  if ("const" in operand) return asNumber(operand.const);
  const l = evalOperand(operand.left, facts);
  const r = evalOperand(operand.right, facts);
  if (l === null || r === null) return null;
  let v: number;
  switch (operand.op) {
    case "add":
      v = l + r;
      break;
    case "sub":
      v = l - r;
      break;
    case "mul":
      v = l * r;
      break;
    case "div":
      if (r === 0) return null;
      v = l / r;
      break;
    default:
      return null;
  }
  return Number.isFinite(v) ? v : null;
}

export function compareNumbers(l: number, r: number, cmp: CmpOp): boolean {
  const eq = Math.abs(l - r) <= REL_EPS * Math.max(1, Math.abs(l), Math.abs(r));
  switch (cmp) {
    case "==":
      return eq;
    case "!=":
      return !eq;
    case "<":
      return !eq && l < r;
    case "<=":
      return eq || l < r;
    case ">":
      return !eq && l > r;
    case ">=":
      return eq || l > r;
  }
}

/** Kleene evaluation: true / false / null (unknown). */
export function evalExpr(expr: Expr, facts: FactMap): Tri {
  switch (expr.op) {
    case "and": {
      let unknown = false;
      for (const arg of expr.args) {
        const v = evalExpr(arg, facts);
        if (v === false) return false; // false dominates
        if (v === null) unknown = true;
      }
      return unknown ? null : true;
    }
    case "or": {
      let unknown = false;
      for (const arg of expr.args) {
        const v = evalExpr(arg, facts);
        if (v === true) return true; // true dominates
        if (v === null) unknown = true;
      }
      return unknown ? null : false;
    }
    case "not": {
      const v = evalExpr(expr.arg, facts);
      return v === null ? null : !v;
    }
    case "fact": {
      const v = facts[expr.fact];
      return typeof v === "boolean" ? v : null;
    }
    case "cmp": {
      const l = evalOperand(expr.left, facts);
      const r = evalOperand(expr.right, facts);
      if (l === null || r === null) return null;
      return compareNumbers(l, r, expr.cmp);
    }
    default:
      return null;
  }
}

/** Facts referenced by an expression, unique, in order of first appearance. */
export function factsInExpr(expr: Expr): FactId[] {
  const seen = new Set<FactId>();
  const visitOperand = (o: Operand) => {
    if ("fact" in o) seen.add(o.fact);
    else if ("op" in o) {
      visitOperand(o.left);
      visitOperand(o.right);
    }
  };
  const visit = (e: Expr) => {
    switch (e.op) {
      case "and":
      case "or":
        e.args.forEach(visit);
        break;
      case "not":
        visit(e.arg);
        break;
      case "fact":
        seen.add(e.fact);
        break;
      case "cmp":
        visitOperand(e.left);
        visitOperand(e.right);
        break;
    }
  };
  visit(expr);
  return [...seen];
}

/** Facts referenced by any rule of the policy, unique, in order of first appearance. */
export function factsInPolicy(policy: Policy): FactId[] {
  return [...new Set(policy.rules.flatMap((r) => factsInExpr(r.when)))];
}

export function evaluatePolicy(policy: Policy, facts: FactMap): PolicyEvaluation {
  const rules: RuleEvaluation[] = policy.rules.map((rule) => {
    const inputs: Partial<Record<FactId, FactValue>> = {};
    for (const f of factsInExpr(rule.when)) inputs[f] = facts[f] ?? null;
    return { ruleId: rule.id, item: rule.item, fired: evalExpr(rule.when, facts), inputs };
  });

  const decisions: ItemDecision[] = VOTE_ITEMS.map((item) => {
    const forItem = rules.filter((r) => r.item === item);
    const firedRules = forItem.filter((r) => r.fired === true).map((r) => r.ruleId);
    const unknownRules = forItem.filter((r) => r.fired === null).map((r) => r.ruleId);
    const vote: Vote = firedRules.length > 0 ? "AGAINST" : unknownRules.length > 0 ? "REVIEW" : "FOR";
    return { item, vote, firedRules, unknownRules };
  });

  return { decisions, rules };
}

/** Item -> vote for an evaluation. */
export function votesOf(evaluation: PolicyEvaluation): Record<VoteItem, Vote> {
  const out = {} as Record<VoteItem, Vote>;
  for (const item of VOTE_ITEMS) {
    out[item] = evaluation.decisions.find((d) => d.item === item)?.vote ?? "REVIEW";
  }
  return out;
}

/** Per-item: do the two evaluations cast the same vote? */
export function votesMatch(a: PolicyEvaluation, b: PolicyEvaluation): Record<VoteItem, boolean> {
  const va = votesOf(a);
  const vb = votesOf(b);
  const out = {} as Record<VoteItem, boolean>;
  for (const item of VOTE_ITEMS) out[item] = va[item] === vb[item];
  return out;
}

/**
 * Is predicted value `a` correct against reference (gold) value `b`?
 * Booleans exact; counts exact after rounding; usd/index within max(0.5, 0.5% of |b|); null only matches null.
 */
export function valuesMatch(
  a: FactValue | undefined,
  b: FactValue | undefined,
  factId: FactId,
): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return x === y;
  if (typeof x !== "number" || typeof y !== "number") return x === y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return x === y;
  if (FACT_BY_ID[factId]?.unit === "count") return Math.round(x) === Math.round(y);
  return Math.abs(x - y) <= Math.max(0.5, 0.005 * Math.abs(y));
}

/**
 * Wrong facts that change a vote: for each fact whose predicted value does not match gold,
 * substitute the gold value alone into `predicted`; if any item's vote changes, it is consequential.
 * Facts absent from `gold` (no answer key) are skipped. Returned in catalog order.
 */
export function consequentialFacts(policy: Policy, predicted: FactMap, gold: FactMap): FactId[] {
  const base = votesOf(evaluatePolicy(policy, predicted));
  const out: FactId[] = [];
  for (const { id } of FACTS) {
    const g = gold[id];
    if (g === undefined) continue;
    if (valuesMatch(predicted[id], g, id)) continue;
    const fixed = votesOf(evaluatePolicy(policy, { ...predicted, [id]: g }));
    if (VOTE_ITEMS.some((item) => fixed[item] !== base[item])) out.push(id);
  }
  return out;
}
