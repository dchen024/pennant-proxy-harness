// Compiles a plain-English voting policy into expression trees with an LLM (structured output).

import { FACTS } from "../facts";
import { chatJSON, parseJsonLoose } from "../openrouter";
import type { Policy, PolicyRule, VoteItem } from "../types";
import { VOTE_ITEMS } from "./evaluate";
import {
  boundedPolicyJsonSchema,
  CompiledPolicyOutputSchema,
  POLICY_JSON_SCHEMA,
  ruleToWire,
  validatePolicy,
} from "./schema";

export interface CompileResult {
  /** null when the call failed or the output could not be turned into a valid policy. */
  policy: Policy | null;
  /** Call error, or schema/structure/validatePolicy errors. Empty on success. */
  errors: string[];
  costUsd: number | null;
  latencyMs: number;
  raw: string;
  /** Which JSON schema the accepted output was produced under ("bounded" = non-recursive fallback). */
  schemaVariant: "recursive" | "bounded" | null;
}

const ITEM_DESCRIPTIONS: Record<VoteItem, string> = {
  nom_gov_chair: "election of the chair of the nominating/governance committee (a director election)",
  say_on_pay: "advisory vote to approve named executive officer compensation (say-on-pay)",
  auditor: "ratification of the independent registered public accounting firm (the auditor)",
};

// Deliberately not one of the policy's own provisions.
const EXAMPLE_RULE: PolicyRule = {
  id: "R1",
  item: "say_on_pay",
  vote: "AGAINST",
  summary: "CEO total pay above $30 million while the CEO also chairs the board.",
  when: {
    op: "and",
    args: [
      { op: "cmp", cmp: ">", left: { fact: "pay.ceo_total_comp_current" }, right: { const: 30_000_000 } },
      { op: "fact", fact: "board.ceo_is_chair" },
    ],
  },
};

export const COMPILE_SYSTEM_PROMPT = `You compile an institutional investor's proxy-voting policy, written in plain English, into boolean expression trees over a fixed catalog of facts extracted from U.S. proxy statements (SEC Form DEF 14A). A deterministic engine evaluates your trees against each company's facts to cast the votes, so translate the policy faithfully and literally.

## Ballot items
${VOTE_ITEMS.map((i) => `- ${i}: ${ITEM_DESCRIPTIONS[i]}`).join("\n")}

## Fact catalog (the only facts you may use)
${FACTS.map((f) => `- ${f.id} [${f.type}${f.unit ? `, ${f.unit}` : ""}]: ${f.description}`).join("\n")}

## Semantics
- A rule casts an AGAINST vote on one ballot item when its condition ("when") is true. An item gets FOR when none of its rules fire, so never write rules for FOR votes or for the default.
- The engine handles missing facts itself (the item goes to analyst review). Never add conditions about missing or undisclosed data.

## Output format
Return one JSON object: {"name": string, "rules": [Rule, ...]}.
Rule = {"id": "R1" | "R2" | ..., "item": ballot item id, "summary": one-sentence paraphrase, "when": Expr}.
Every Expr object has all five keys "op", "args", "fact", "cmp", "operands". Keys the op does not use are "" (fact, cmp) or [] (args, operands).
- {"op": "and" | "or", "args": [Expr, Expr, ...]}: true when all / any of the args are true.
- {"op": "not", "args": [Expr]}: exactly one arg.
- {"op": "fact", "fact": <boolean fact id>}: true when that yes/no fact is true.
- {"op": "cmp", "cmp": "<" | "<=" | ">" | ">=" | "==" | "!=", "operands": [left, right]}: compares two Operands, left cmp right.
Every Operand object has all four keys "kind", "fact", "value", "operands". Keys the kind does not use are "" (fact), 0 (value) or [] (operands).
- {"kind": "fact", "fact": <numeric fact id>}
- {"kind": "const", "value": <number>}
- {"kind": "add" | "sub" | "mul" | "div", "operands": [left, right]}: left + right, left - right, left * right, left / right.

## Translation rules
1. One rule per numbered provision that calls for an AGAINST vote, with ids "R1", "R2", ... in the order the provisions appear.
2. Use only catalog fact ids. Boolean facts appear only in {"op": "fact"}; numeric facts only inside Operands.
3. Keep the exact strictness of each comparison: "fewer than", "less than", "below" are <; "at most", "no more than" are <=; "more than", "exceeds", "above", "increased" are >; "at least" is >=.
4. Write fractions exactly, as a division of two constants (one-third is 1 / 3), never as a rounded decimal. Dollar amounts are plain US dollars ($2.5 million is 2500000); percentages are fractions (15% is 0.15).
5. Do not add conditions the text does not state.

## Example
Provision: "We vote AGAINST the say-on-pay proposal if the CEO's total pay exceeds $30 million and the CEO also chairs the board."
Rule: ${JSON.stringify(ruleToWire(EXAMPLE_RULE))}`;

/** Turns a failed output into readable errors (re-runs the output schema to get the issue list). */
function outputErrors(raw: string, fallback: string | undefined): string[] {
  let json: unknown;
  try {
    json = parseJsonLoose(raw);
  } catch (err) {
    return [`output is not JSON: ${err instanceof Error ? err.message : String(err)}`];
  }
  const parsed = CompiledPolicyOutputSchema.safeParse(json);
  if (parsed.success) return [fallback ?? "invalid output"];
  return parsed.error.issues.map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message));
}

/**
 * Compiles `text` with `model`. Tries the recursive JSON schema first; if the provider rejects the
 * request (e.g. no support for recursive schemas), retries once with the depth-bounded schema.
 */
export async function compilePolicy(text: string, model: string): Promise<CompileResult> {
  const started = Date.now();
  const errors: string[] = [];
  let costUsd: number | null = null;
  let raw = "";

  const variants = [
    { name: "recursive" as const, jsonSchema: POLICY_JSON_SCHEMA },
    { name: "bounded" as const, jsonSchema: boundedPolicyJsonSchema() },
  ];
  for (const variant of variants) {
    const res = await chatJSON({
      model,
      system: COMPILE_SYSTEM_PROMPT,
      user: `Compile this voting policy.\n\n<policy>\n${text}\n</policy>`,
      schema: CompiledPolicyOutputSchema,
      jsonSchema: variant.jsonSchema,
      schemaName: "voting_policy",
      maxTokens: 8000,
    });
    if (res.costUsd !== null) costUsd = (costUsd ?? 0) + res.costUsd;
    raw = res.raw;

    if (res.data) {
      const policy: Policy = { id: `compiled:${model}`, name: res.data.name, text, rules: res.data.rules };
      return {
        policy,
        errors: validatePolicy(policy), // already enforced by the output schema; kept as a guard
        costUsd,
        latencyMs: Date.now() - started,
        raw,
        schemaVariant: variant.name,
      };
    }
    if (res.malformed) {
      errors.push(...outputErrors(res.raw, res.error));
      break; // the provider accepted the schema; the model just got it wrong twice
    }
    errors.push(`${variant.name} schema request failed: ${res.error ?? "unknown error"}`);
  }

  return { policy: null, errors, costUsd, latencyMs: Date.now() - started, raw, schemaVariant: null };
}
