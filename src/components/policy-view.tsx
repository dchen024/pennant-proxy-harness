import { FACT_BY_ID } from "@/lib/facts";
import { formatValue } from "@/lib/format";
import type { Expr, FactId, FactValue, ItemDecision, Operand, PolicyRule, RuleEvaluation, Vote, VoteItem } from "@/lib/types";
import { cn } from "@/lib/utils";

export const VOTE_ITEM_LABEL: Record<VoteItem, string> = {
  nom_gov_chair: "Nominating/governance chair",
  say_on_pay: "Say-on-pay",
  auditor: "Auditor ratification",
};

export function FactPill({ id, value, showValue }: { id: FactId; value?: FactValue; showValue?: boolean }) {
  const def = FACT_BY_ID[id];
  return (
    <span
      className="inline-flex items-center gap-1 rounded border bg-background px-1.5 py-px text-[11.5px]"
      title={`${id}\n${def?.description ?? ""}`}
    >
      <span>{def?.label ?? id}</span>
      {showValue ? (
        <span className="border-l pl-1 font-mono text-[11px] tabular-nums text-muted-foreground">
          {formatValue(value ?? null, id, { compact: true })}
        </span>
      ) : null}
    </span>
  );
}

function num(n: number): string {
  if (Math.abs(n - 2 / 3) < 1e-9) return "⅔";
  if (Math.abs(n - 1 / 3) < 1e-9) return "⅓";
  return Number.isInteger(n) ? n.toLocaleString("en-US") : String(Number(n.toPrecision(4)));
}

const ARITH: Record<string, string> = { add: "+", sub: "−", mul: "×", div: "÷" };
const CMP: Record<string, string> = { "<": "<", "<=": "≤", ">": ">", ">=": "≥", "==": "=", "!=": "≠" };

function OperandView({ o, inputs }: { o: Operand; inputs?: Partial<Record<FactId, FactValue>> }) {
  if ("fact" in o) return <FactPill id={o.fact} value={inputs?.[o.fact]} showValue={!!inputs} />;
  if ("const" in o) return <span className="font-mono text-[12px]">{num(o.const)}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="text-muted-foreground">(</span>
      <OperandView o={o.left} inputs={inputs} />
      <span className="font-mono text-[12px]">{ARITH[o.op]}</span>
      <OperandView o={o.right} inputs={inputs} />
      <span className="text-muted-foreground">)</span>
    </span>
  );
}

export function ExprView({ e, inputs }: { e: Expr; inputs?: Partial<Record<FactId, FactValue>> }) {
  switch (e.op) {
    case "and":
    case "or":
      return (
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {e.op === "and" ? "All of" : "Any of"}
          </div>
          <div className="space-y-1.5 border-l-2 pl-3">
            {e.args.map((a, i) => (
              <ExprView key={i} e={a} inputs={inputs} />
            ))}
          </div>
        </div>
      );
    case "not":
      return (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded bg-muted px-1 py-px text-[10px] font-semibold uppercase tracking-wider">not</span>
          <ExprView e={e.arg} inputs={inputs} />
        </div>
      );
    case "fact":
      return (
        <div className="flex items-center gap-1.5">
          <FactPill id={e.fact} value={inputs?.[e.fact]} showValue={!!inputs} />
          <span className="text-[11px] text-muted-foreground">is true</span>
        </div>
      );
    case "cmp":
      return (
        <div className="flex flex-wrap items-center gap-1.5">
          <OperandView o={e.left} inputs={inputs} />
          <span className="font-mono text-[13px]">{CMP[e.cmp] ?? e.cmp}</span>
          <OperandView o={e.right} inputs={inputs} />
        </div>
      );
  }
}

export function RuleCard({ rule, evaluation }: { rule: PolicyRule; evaluation?: RuleEvaluation }) {
  const fired = evaluation?.fired;
  return (
    <div
      className={cn(
        "rounded-md border bg-card p-3",
        fired === true && "border-red-300 bg-red-50/40",
        fired === null && evaluation && "border-amber-300 bg-amber-50/40",
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-[11px] font-semibold">{rule.id}</span>
        <span className="text-[11px] text-muted-foreground">{VOTE_ITEM_LABEL[rule.item]}</span>
        <span className="rounded bg-red-600/10 px-1.5 py-px text-[10px] font-semibold text-red-700">AGAINST if</span>
        {evaluation ? (
          <span
            className={cn(
              "ml-auto rounded px-1.5 py-px text-[10px] font-semibold uppercase",
              fired === true && "bg-red-600 text-white",
              fired === false && "bg-emerald-100 text-emerald-800",
              fired === null && "bg-amber-200 text-amber-900",
            )}
          >
            {fired === true ? "fired" : fired === false ? "not fired" : "unknown"}
          </span>
        ) : null}
      </div>
      <p className="mb-2 text-[12px]">{rule.summary}</p>
      <ExprView e={rule.when} inputs={evaluation?.inputs} />
    </div>
  );
}

export function VoteBadge({ vote, className }: { vote: Vote; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-16 justify-center rounded px-2 py-0.5 font-mono text-[11px] font-semibold tracking-wide",
        vote === "FOR" && "bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-600/25",
        vote === "AGAINST" && "bg-red-600 text-white",
        vote === "REVIEW" && "bg-amber-100 text-amber-900 ring-1 ring-inset ring-amber-600/30",
        className,
      )}
    >
      {vote}
    </span>
  );
}

export function DecisionRow({ d }: { d: ItemDecision }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-48 text-[12px]">{VOTE_ITEM_LABEL[d.item]}</span>
      <VoteBadge vote={d.vote} />
      <span className="font-mono text-[11px] text-muted-foreground">
        {d.firedRules.length ? `fired ${d.firedRules.join(", ")}` : ""}
        {d.unknownRules.length ? ` unknown ${d.unknownRules.join(", ")}` : ""}
      </span>
    </div>
  );
}
