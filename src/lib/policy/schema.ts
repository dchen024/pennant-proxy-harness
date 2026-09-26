// Schemas for policies: the canonical tree types (types.ts) and the flat "wire" encoding
// the compiler LLM emits under strict JSON-schema structured output.

import { z } from "zod";
import { FACT_BY_ID, FACTS } from "../facts";
import { FACT_IDS } from "../types";
import type { Expr, FactId, Operand, Policy, PolicyRule, VoteItem } from "../types";
import { VOTE_ITEMS, type CmpOp } from "./evaluate";

export const CMP_OPS = ["<", "<=", ">", ">=", "==", "!="] as const satisfies readonly CmpOp[];
const ARITH_OPS = ["add", "sub", "mul", "div"] as const;
const EXPR_OPS = ["and", "or", "not", "fact", "cmp"] as const;
const OPERAND_KINDS = ["fact", "const", ...ARITH_OPS] as const;

// ---------------------------------------------------------------------------
// Canonical schemas (parse into the types in types.ts)
// ---------------------------------------------------------------------------

export const FactIdSchema = z.enum(FACT_IDS);
export const VoteItemSchema = z.enum(VOTE_ITEMS as [VoteItem, ...VoteItem[]]);
export const CmpOpSchema = z.enum(CMP_OPS);

export const OperandSchema: z.ZodType<Operand> = z.lazy(() =>
  z.union([
    z.strictObject({ fact: FactIdSchema }),
    z.strictObject({ const: z.number() }),
    z.strictObject({ op: z.enum(ARITH_OPS), left: OperandSchema, right: OperandSchema }),
  ]),
);

export const ExprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.strictObject({ op: z.enum(["and", "or"]), args: z.array(ExprSchema) }),
    z.strictObject({ op: z.literal("not"), arg: ExprSchema }),
    z.strictObject({ op: z.literal("fact"), fact: FactIdSchema }),
    z.strictObject({ op: z.literal("cmp"), cmp: CmpOpSchema, left: OperandSchema, right: OperandSchema }),
  ]),
);

export const PolicyRuleSchema: z.ZodType<PolicyRule> = z.object({
  id: z.string().min(1),
  item: VoteItemSchema,
  vote: z.literal("AGAINST"),
  when: ExprSchema,
  summary: z.string(),
});

/** Extra keys (e.g. Mongo `_id`, `compiledBy`) are stripped. */
export const PolicySchema: z.ZodType<Policy> = z.object({
  id: z.string(),
  name: z.string(),
  text: z.string(),
  rules: z.array(PolicyRuleSchema),
});

// ---------------------------------------------------------------------------
// Semantic validation
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === "object" && v !== null && !Array.isArray(v);

function validateOperand(o: unknown, path: string, errors: string[]): void {
  if (!isObj(o)) {
    errors.push(`${path}: expected an operand object`);
  } else if ("fact" in o) {
    const def = FACT_BY_ID[o.fact as FactId];
    if (!def) errors.push(`${path}: unknown fact "${String(o.fact)}"`);
    else if (def.type !== "number") errors.push(`${path}: boolean fact "${def.id}" used as a numeric operand`);
  } else if ("const" in o) {
    if (typeof o.const !== "number" || !Number.isFinite(o.const)) errors.push(`${path}: const must be a finite number`);
  } else if ((ARITH_OPS as readonly unknown[]).includes(o.op)) {
    validateOperand(o.left, `${path}.left`, errors);
    validateOperand(o.right, `${path}.right`, errors);
  } else {
    errors.push(`${path}: invalid operand (expected {fact}, {const} or {op: add|sub|mul|div, left, right})`);
  }
}

function validateExpr(e: unknown, path: string, errors: string[]): void {
  if (!isObj(e)) {
    errors.push(`${path}: expected an expression object`);
    return;
  }
  switch (e.op) {
    case "and":
    case "or":
      if (!Array.isArray(e.args) || e.args.length === 0) errors.push(`${path}: "${e.op}" has no arguments`);
      else e.args.forEach((a, i) => validateExpr(a, `${path}.args[${i}]`, errors));
      return;
    case "not":
      validateExpr(e.arg, `${path}.arg`, errors);
      return;
    case "fact": {
      const def = FACT_BY_ID[e.fact as FactId];
      if (!def) errors.push(`${path}: unknown fact "${String(e.fact)}"`);
      else if (def.type !== "boolean")
        errors.push(`${path}: numeric fact "${def.id}" used as a condition (op "fact"); compare it with op "cmp"`);
      return;
    }
    case "cmp":
      if (!(CMP_OPS as readonly unknown[]).includes(e.cmp)) errors.push(`${path}: invalid comparison "${String(e.cmp)}"`);
      validateOperand(e.left, `${path}.left`, errors);
      validateOperand(e.right, `${path}.right`, errors);
      return;
    default:
      errors.push(`${path}: unknown op "${String(e.op)}"`);
  }
}

/** Semantic checks on rules (safe on untrusted, unparsed data). Returns human-readable errors. */
export function validateRules(rules: readonly PolicyRule[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(rules)) return ["rules must be an array"];
  const ids = new Set<string>();
  rules.forEach((rule: unknown, i) => {
    if (!isObj(rule)) {
      errors.push(`rules[${i}]: expected a rule object`);
      return;
    }
    const id = typeof rule.id === "string" && rule.id ? rule.id : null;
    const label = id ?? `rules[${i}]`;
    if (!id) errors.push(`${label}: missing id`);
    else if (ids.has(id)) errors.push(`${label}: duplicate rule id`);
    else ids.add(id);
    if (!(VOTE_ITEMS as readonly unknown[]).includes(rule.item))
      errors.push(`${label}: item "${String(rule.item)}" is not a vote item (${VOTE_ITEMS.join(", ")})`);
    validateExpr(rule.when, `${label} when`, errors);
  });
  return errors;
}

/**
 * Semantic checks: unknown fact ids, boolean facts used as numeric operands, numeric facts
 * used in a `fact` op, empty and/or, rules whose item isn't a VoteItem (plus malformed nodes
 * and duplicate rule ids). Empty array = valid.
 */
export function validatePolicy(policy: Policy): string[] {
  if (!isObj(policy)) return ["policy must be an object"];
  return validateRules(policy.rules);
}

// ---------------------------------------------------------------------------
// Wire format for LLM structured output, converted to Expr/Operand in code.
// Built to survive strict structured-output grammars (OpenAI strict mode, Anthropic):
// - every node is one object type with every key present (no per-op variants);
// - no nullable unions: unused keys are "" (strings), 0 (value) or [] (arrays);
// - children go in arrays (`args`, `operands: [left, right]`), so each level references
//   its child schema once. Providers that inline $refs (Anthropic) then get a small grammar.
// ---------------------------------------------------------------------------

export interface WireOperand {
  kind: (typeof OPERAND_KINDS)[number];
  fact?: FactId | "" | null;
  value?: number | null;
  /** [left, right] for add/sub/mul/div; [] otherwise. */
  operands?: WireOperand[] | null;
}

export interface WireExpr {
  op: (typeof EXPR_OPS)[number];
  /** Sub-expressions: 2+ for and/or, exactly 1 for not; [] otherwise. */
  args?: WireExpr[] | null;
  fact?: FactId | "" | null;
  cmp?: CmpOp | "" | null;
  /** [left, right] for cmp; [] otherwise. */
  operands?: WireOperand[] | null;
}

export interface WireRule {
  id: string;
  item: VoteItem;
  summary?: string | null;
  when: WireExpr;
}

export interface WirePolicy {
  name?: string | null;
  rules: WireRule[];
}

// Lenient about absent/null/"" unused keys (providers that ignore the JSON schema), strict about enums.
const OptFactSchema = z.enum(["", ...FACT_IDS]).nullish();

export const WireOperandSchema: z.ZodType<WireOperand> = z.lazy(() =>
  z.object({
    kind: z.enum(OPERAND_KINDS),
    fact: OptFactSchema,
    value: z.number().nullish(),
    operands: z.array(WireOperandSchema).nullish(),
  }),
);

export const WireExprSchema: z.ZodType<WireExpr> = z.lazy(() =>
  z.object({
    op: z.enum(EXPR_OPS),
    args: z.array(WireExprSchema).nullish(),
    fact: OptFactSchema,
    cmp: z.enum(["", ...CMP_OPS]).nullish(),
    operands: z.array(WireOperandSchema).nullish(),
  }),
);

export const WirePolicySchema: z.ZodType<WirePolicy> = z.object({
  name: z.string().nullish(),
  rules: z.array(
    z.object({
      id: z.string().min(1),
      item: VoteItemSchema,
      summary: z.string().nullish(),
      when: WireExprSchema,
    }),
  ),
});

function leftRight<T>(xs: T[] | null | undefined): [T, T] | null {
  return xs && xs.length === 2 ? [xs[0], xs[1]] : null;
}

export function wireToOperand(w: WireOperand, path: string, errors: string[]): Operand | null {
  switch (w.kind) {
    case "fact":
      if (!w.fact) {
        errors.push(`${path}: kind "fact" needs a numeric fact id in "fact"`);
        return null;
      }
      return { fact: w.fact };
    case "const":
      if (w.value == null) {
        errors.push(`${path}: kind "const" needs a number in "value"`);
        return null;
      }
      return { const: w.value };
    default: {
      const lr = leftRight(w.operands);
      if (!lr) {
        errors.push(`${path}: kind "${w.kind}" needs exactly two entries in "operands" (got ${w.operands?.length ?? 0})`);
        return null;
      }
      const left = wireToOperand(lr[0], `${path}.operands[0]`, errors);
      const right = wireToOperand(lr[1], `${path}.operands[1]`, errors);
      return left && right ? { op: w.kind, left, right } : null;
    }
  }
}

export function wireToExpr(w: WireExpr, path: string, errors: string[]): Expr | null {
  switch (w.op) {
    case "and":
    case "or": {
      const args = (w.args ?? []).map((a, i) => wireToExpr(a, `${path}.args[${i}]`, errors));
      return args.every((a): a is Expr => a !== null) ? { op: w.op, args } : null;
    }
    case "not": {
      if (!w.args || w.args.length !== 1) {
        errors.push(`${path}: op "not" needs exactly one expression in "args" (got ${w.args?.length ?? 0})`);
        return null;
      }
      const arg = wireToExpr(w.args[0], `${path}.args[0]`, errors);
      return arg && { op: "not", arg };
    }
    case "fact":
      if (!w.fact) {
        errors.push(`${path}: op "fact" needs a boolean fact id in "fact"`);
        return null;
      }
      return { op: "fact", fact: w.fact };
    case "cmp": {
      const lr = leftRight(w.operands);
      if (!w.cmp || !lr) {
        errors.push(`${path}: op "cmp" needs "cmp" and exactly two entries in "operands" (got ${w.operands?.length ?? 0})`);
        return null;
      }
      const left = wireToOperand(lr[0], `${path}.operands[0]`, errors);
      const right = wireToOperand(lr[1], `${path}.operands[1]`, errors);
      return left && right ? { op: "cmp", cmp: w.cmp, left, right } : null;
    }
  }
}

/** Wire rules -> canonical rules. Returns null (and pushes errors) if any node is structurally incomplete. */
export function wireToRules(wire: WirePolicy, errors: string[]): PolicyRule[] | null {
  const rules = wire.rules.map((r) => {
    const when = wireToExpr(r.when, `${r.id} when`, errors);
    return when && { id: r.id, item: r.item, vote: "AGAINST" as const, when, summary: r.summary ?? "" };
  });
  return rules.every((r): r is PolicyRule => r !== null) ? rules : null;
}

export function operandToWire(o: Operand): WireOperand {
  if ("fact" in o) return { kind: "fact", fact: o.fact, value: 0, operands: [] };
  if ("const" in o) return { kind: "const", fact: "", value: o.const, operands: [] };
  return { kind: o.op, fact: "", value: 0, operands: [operandToWire(o.left), operandToWire(o.right)] };
}

export function exprToWire(e: Expr): WireExpr {
  // Keys in schema order, "op" first.
  const node = (op: WireExpr["op"], fields: Partial<WireExpr>): WireExpr => ({
    op,
    args: [],
    fact: "",
    cmp: "",
    operands: [],
    ...fields,
  });
  switch (e.op) {
    case "and":
    case "or":
      return node(e.op, { args: e.args.map(exprToWire) });
    case "not":
      return node("not", { args: [exprToWire(e.arg)] });
    case "fact":
      return node("fact", { fact: e.fact });
    case "cmp":
      return node("cmp", { cmp: e.cmp, operands: [operandToWire(e.left), operandToWire(e.right)] });
  }
}

export function ruleToWire(r: PolicyRule): WireRule {
  return { id: r.id, item: r.item, summary: r.summary, when: exprToWire(r.when) };
}

export interface CompiledRules {
  name: string;
  rules: PolicyRule[];
}

/**
 * Validates LLM output: wire schema -> canonical rules -> semantic checks. Any problem becomes a
 * zod issue, so chatJSON's repair retry sends the model the exact error.
 */
export const CompiledPolicyOutputSchema = WirePolicySchema.transform((wire, ctx): CompiledRules => {
  const errors: string[] = [];
  const rules = wireToRules(wire, errors);
  if (rules) errors.push(...validateRules(rules));
  if (!rules || errors.length > 0) {
    for (const message of errors) ctx.addIssue(message);
    return z.NEVER;
  }
  return { name: wire.name?.trim() || "Compiled policy", rules };
});

// ---------------------------------------------------------------------------
// JSON Schema for strict structured output (OpenAI strict-mode rules: every property
// required, additionalProperties false; accepted by Anthropic's validator too).
// ---------------------------------------------------------------------------

const BOOLEAN_FACT_IDS = FACTS.filter((f) => f.type === "boolean").map((f) => f.id);
const NUMERIC_FACT_IDS = FACTS.filter((f) => f.type === "number").map((f) => f.id);

const EXPR_FACT_FIELD = {
  type: "string",
  enum: ["", ...BOOLEAN_FACT_IDS],
  description: 'Boolean fact id when op is "fact"; otherwise "".',
};
const CMP_FIELD = { type: "string", enum: ["", ...CMP_OPS], description: 'Comparison when op is "cmp"; otherwise "".' };
const OPERAND_FACT_FIELD = {
  type: "string",
  enum: ["", ...NUMERIC_FACT_IDS],
  description: 'Numeric fact id when kind is "fact"; otherwise "".',
};
const VALUE_FIELD = { type: "number", description: 'The number when kind is "const"; otherwise 0.' };
const ARGS_DESC = 'Sub-expressions: 2 or more for "and"/"or", exactly 1 for "not"; otherwise [].';
const EXPR_OPERANDS_DESC = 'Exactly [left, right] when op is "cmp"; otherwise [].';
const OPERAND_OPERANDS_DESC = "Exactly [left, right] for add/sub/mul/div; otherwise [].";
const arrayOf = (def: string, description: string) => ({ type: "array", items: { $ref: `#/$defs/${def}` }, description });

function policyRoot(whenDef: string, defs: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["name", "rules"],
    properties: {
      name: { type: "string", description: "Short name of the policy." },
      rules: {
        type: "array",
        description: "One rule per provision that calls for an AGAINST vote.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "item", "summary", "when"],
          properties: {
            id: { type: "string", description: 'Provision number: "R1", "R2", ...' },
            item: { type: "string", enum: [...VOTE_ITEMS], description: "Ballot item this rule votes AGAINST." },
            summary: { type: "string", description: "One-sentence paraphrase of the condition." },
            when: { $ref: `#/$defs/${whenDef}` },
          },
        },
      },
    },
    $defs: defs,
  };
}

/** Recursive schema: expr and operand refer to themselves through $defs (OpenAI strict mode supports this). */
export const POLICY_JSON_SCHEMA: Record<string, unknown> = policyRoot("expr", {
  expr: {
    type: "object",
    additionalProperties: false,
    required: ["op", "args", "fact", "cmp", "operands"],
    properties: {
      op: { type: "string", enum: [...EXPR_OPS] },
      args: arrayOf("expr", ARGS_DESC),
      fact: EXPR_FACT_FIELD,
      cmp: CMP_FIELD,
      operands: arrayOf("operand", EXPR_OPERANDS_DESC),
    },
  },
  operand: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "fact", "value", "operands"],
    properties: {
      kind: { type: "string", enum: [...OPERAND_KINDS] },
      fact: OPERAND_FACT_FIELD,
      value: VALUE_FIELD,
      operands: arrayOf("operand", OPERAND_OPERANDS_DESC),
    },
  },
});

/**
 * Same encoding unrolled to a fixed depth, with no recursive $ref. Fallback for providers that
 * reject recursive schemas (Anthropic: "Circular reference detected in schema definitions").
 * Leaf levels drop their child arrays. Default depths allow and/or > not > and/or > leaf and
 * div > add > fact, which covers any realistic rule.
 */
export function boundedPolicyJsonSchema(exprDepth = 4, operandDepth = 3): Record<string, unknown> {
  const defs: Record<string, unknown> = {};
  for (let d = 0; d < operandDepth; d++) {
    const leaf = d === 0;
    defs[`operand${d}`] = {
      type: "object",
      additionalProperties: false,
      required: leaf ? ["kind", "fact", "value"] : ["kind", "fact", "value", "operands"],
      properties: {
        kind: { type: "string", enum: leaf ? ["fact", "const"] : [...OPERAND_KINDS] },
        fact: OPERAND_FACT_FIELD,
        value: VALUE_FIELD,
        ...(leaf ? {} : { operands: arrayOf(`operand${d - 1}`, OPERAND_OPERANDS_DESC) }),
      },
    };
  }
  for (let d = 0; d < exprDepth; d++) {
    const leaf = d === 0;
    defs[`expr${d}`] = {
      type: "object",
      additionalProperties: false,
      required: leaf ? ["op", "fact", "cmp", "operands"] : ["op", "args", "fact", "cmp", "operands"],
      properties: {
        op: { type: "string", enum: leaf ? ["fact", "cmp"] : [...EXPR_OPS] },
        ...(leaf ? {} : { args: arrayOf(`expr${d - 1}`, ARGS_DESC) }),
        fact: EXPR_FACT_FIELD,
        cmp: CMP_FIELD,
        operands: arrayOf(`operand${operandDepth - 1}`, EXPR_OPERANDS_DESC),
      },
    };
  }
  return policyRoot(`expr${exprDepth - 1}`, defs);
}
