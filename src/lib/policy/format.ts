// Human-readable rendering of policy trees (CLI output, UI labels).

import type { Expr, Operand, PolicyRule } from "../types";

const ARITH_SYMBOL = { add: "+", sub: "-", mul: "*", div: "/" } as const;

export function formatNumber(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString("en-US") : String(Number(n.toPrecision(6)));
}

export function formatOperand(o: Operand, nested = false): string {
  if ("fact" in o) return o.fact;
  if ("const" in o) return formatNumber(o.const);
  const s = `${formatOperand(o.left, true)} ${ARITH_SYMBOL[o.op]} ${formatOperand(o.right, true)}`;
  return nested ? `(${s})` : s;
}

export function formatExpr(e: Expr, nested = false): string {
  switch (e.op) {
    case "and":
    case "or": {
      const s = e.args.map((a) => formatExpr(a, true)).join(` ${e.op.toUpperCase()} `);
      return nested && e.args.length > 1 ? `(${s})` : s;
    }
    case "not":
      return e.arg.op === "cmp" ? `NOT (${formatExpr(e.arg)})` : `NOT ${formatExpr(e.arg, true)}`;
    case "fact":
      return e.fact;
    case "cmp":
      return `${formatOperand(e.left)} ${e.cmp} ${formatOperand(e.right)}`;
  }
}

/** e.g. `R2 [nom_gov_chair] AGAINST if board.ceo_is_chair AND NOT board.has_lead_independent_director` */
export function formatRule(r: PolicyRule): string {
  return `${r.id} [${r.item}] ${r.vote} if ${formatExpr(r.when)}`;
}
