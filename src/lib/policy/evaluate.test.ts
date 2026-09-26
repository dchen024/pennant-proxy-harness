import { describe, expect, it } from "vitest";
import type { Expr, FactId, FactMap, Policy, Tri } from "../types";
import {
  consequentialFacts,
  evalExpr,
  evalOperand,
  evaluatePolicy,
  factsInExpr,
  factsInPolicy,
  valuesMatch,
  votesMatch,
  votesOf,
} from "./evaluate";
import { formatRule } from "./format";
import { GOLD_POLICY } from "./policy";
import {
  CompiledPolicyOutputSchema,
  PolicySchema,
  POLICY_JSON_SCHEMA,
  boundedPolicyJsonSchema,
  ruleToWire,
  validatePolicy,
} from "./schema";

/** A company where no gold rule fires: every item is FOR. */
const CLEAN: FactMap = {
  "board.nominee_count": 10,
  "board.independent_nominee_count": 9,
  "board.ceo_is_chair": true,
  "board.has_lead_independent_director": true,
  "governance.unequal_voting_rights": false,
  "governance.unequal_voting_sunset": false,
  "pay.ceo_total_comp_current": 12_000_000,
  "pay.ceo_total_comp_prior": 10_000_000,
  "pay.company_tsr_current": 180,
  "pay.peer_tsr_current": 150,
  "audit.audit_fees_current": 5_000_000,
  "audit.audit_related_fees_current": 500_000,
  "audit.tax_fees_current": 1_000_000,
  "audit.all_other_fees_current": 100_000,
};

const votes = (facts: FactMap, policy: Policy = GOLD_POLICY) => votesOf(evaluatePolicy(policy, facts));
const omit = (facts: FactMap, id: FactId): FactMap => {
  const copy = { ...facts };
  delete copy[id];
  return copy;
};
const decision = (facts: FactMap, item: string) =>
  evaluatePolicy(GOLD_POLICY, facts).decisions.find((d) => d.item === item)!;

// Two boolean facts used as Kleene variables.
const A = "board.ceo_is_chair" as const;
const B = "board.has_lead_independent_director" as const;
const fa: Expr = { op: "fact", fact: A };
const fb: Expr = { op: "fact", fact: B };
const tri = (a: Tri, b: Tri): FactMap => ({ [A]: a, [B]: b });

describe("Kleene three-valued logic", () => {
  const T = true, F = false, U = null;
  const cases: Array<[Tri, Tri, Tri, Tri]> = [
    // a, b, a AND b, a OR b
    [T, T, T, T],
    [T, F, F, T],
    [F, T, F, T],
    [F, F, F, F],
    [T, U, U, T],
    [U, T, U, T],
    [F, U, F, U],
    [U, F, F, U],
    [U, U, U, U],
  ];
  it.each(cases)("a=%s b=%s -> and=%s or=%s", (a, b, and, or) => {
    expect(evalExpr({ op: "and", args: [fa, fb] }, tri(a, b))).toBe(and);
    expect(evalExpr({ op: "or", args: [fa, fb] }, tri(a, b))).toBe(or);
  });

  it("not", () => {
    expect(evalExpr({ op: "not", arg: fa }, tri(true, null))).toBe(false);
    expect(evalExpr({ op: "not", arg: fa }, tri(false, null))).toBe(true);
    expect(evalExpr({ op: "not", arg: fa }, tri(null, null))).toBe(null);
    expect(evalExpr({ op: "not", arg: fa }, {})).toBe(null); // missing key == unknown
  });

  it("fact op on a numeric fact is unknown", () => {
    expect(evalExpr({ op: "fact", fact: "board.nominee_count" }, { "board.nominee_count": 1 })).toBe(null);
  });

  it("arithmetic propagates null and treats division by zero as unknown", () => {
    const div = { op: "div", left: { fact: "board.independent_nominee_count" }, right: { fact: "board.nominee_count" } } as const;
    expect(evalOperand(div, { "board.independent_nominee_count": 6, "board.nominee_count": 8 })).toBe(0.75);
    expect(evalOperand(div, { "board.independent_nominee_count": 6 })).toBe(null);
    expect(evalOperand(div, { "board.independent_nominee_count": 6, "board.nominee_count": 0 })).toBe(null);
    expect(evalOperand({ fact: "board.ceo_is_chair" }, { "board.ceo_is_chair": true })).toBe(null);
    const cmp: Expr = { op: "cmp", cmp: "<", left: div, right: { const: 1 } };
    expect(evalExpr(cmp, { "board.independent_nominee_count": 6, "board.nominee_count": 0 })).toBe(null);
  });

  it("comparisons are exact at ties despite float noise", () => {
    const ratio: Expr = GOLD_POLICY.rules[0].when; // independent / nominees < 2/3
    for (const n of [3, 6, 9, 12, 15]) {
      const f = { "board.nominee_count": n, "board.independent_nominee_count": (2 * n) / 3 };
      expect(evalExpr(ratio, f)).toBe(false);
      // Equivalent encoding: independent < nominees * (2/3)
      const mul: Expr = {
        op: "cmp",
        cmp: "<",
        left: { fact: "board.independent_nominee_count" },
        right: { op: "mul", left: { fact: "board.nominee_count" }, right: { const: 2 / 3 } },
      };
      expect(evalExpr(mul, f)).toBe(false);
    }
  });
});

describe("GOLD_POLICY rules", () => {
  it("votes FOR everything on a clean company", () => {
    const ev = evaluatePolicy(GOLD_POLICY, CLEAN);
    expect(ev.decisions.map((d) => [d.item, d.vote])).toEqual([
      ["nom_gov_chair", "FOR"],
      ["say_on_pay", "FOR"],
      ["auditor", "FOR"],
    ]);
    expect(ev.rules.every((r) => r.fired === false)).toBe(true);
  });

  it("R1 fires below two-thirds independent, not at exactly two-thirds", () => {
    expect(decision({ ...CLEAN, "board.independent_nominee_count": 6 }, "nom_gov_chair")).toMatchObject({
      vote: "AGAINST",
      firedRules: ["R1"],
    });
    expect(votes({ ...CLEAN, "board.nominee_count": 9, "board.independent_nominee_count": 6 }).nom_gov_chair).toBe("FOR");
    expect(votes({ ...CLEAN, "board.nominee_count": 9, "board.independent_nominee_count": 5 }).nom_gov_chair).toBe("AGAINST");
  });

  it("R2 fires for a combined CEO/chair without a lead independent director", () => {
    const f = { ...CLEAN, "board.has_lead_independent_director": false };
    expect(decision(f, "nom_gov_chair")).toMatchObject({ vote: "AGAINST", firedRules: ["R2"] });
    expect(votes({ ...f, "board.ceo_is_chair": false }).nom_gov_chair).toBe("FOR");
  });

  it("R3 fires for unequal voting rights without a sunset", () => {
    const f = { ...CLEAN, "governance.unequal_voting_rights": true };
    expect(decision(f, "nom_gov_chair")).toMatchObject({ vote: "AGAINST", firedRules: ["R3"] });
    expect(votes({ ...f, "governance.unequal_voting_sunset": true }).nom_gov_chair).toBe("FOR");
  });

  it("R4 fires when pay rose while TSR trailed peers", () => {
    const f = { ...CLEAN, "pay.company_tsr_current": 120 };
    expect(decision(f, "say_on_pay")).toMatchObject({ vote: "AGAINST", firedRules: ["R4"] });
    expect(votes({ ...f, "pay.ceo_total_comp_current": 9_000_000 }).say_on_pay).toBe("FOR"); // pay fell
    expect(votes({ ...f, "pay.ceo_total_comp_current": 10_000_000 }).say_on_pay).toBe("FOR"); // flat is not an increase
    expect(votes({ ...f, "pay.company_tsr_current": 150 }).say_on_pay).toBe("FOR"); // equal TSR is not below
  });

  it("R5 fires when non-audit fees exceed audit + audit-related fees", () => {
    const f = { ...CLEAN, "audit.tax_fees_current": 5_000_000, "audit.all_other_fees_current": 600_000 };
    expect(decision(f, "auditor")).toMatchObject({ vote: "AGAINST", firedRules: ["R5"] });
    // equal is not "exceed"
    expect(votes({ ...f, "audit.all_other_fees_current": 500_000 }).auditor).toBe("FOR");
  });

  it("REVIEW when a needed fact is missing, but not when the answer is already decided", () => {
    const f = { ...CLEAN, "pay.company_tsr_current": 120, "pay.peer_tsr_current": null };
    expect(decision(f, "say_on_pay")).toMatchObject({ vote: "REVIEW", firedRules: [], unknownRules: ["R4"] });
    // pay fell: false AND unknown = false, so FOR despite the gap
    expect(votes({ ...f, "pay.ceo_total_comp_current": 9_000_000 }).say_on_pay).toBe("FOR");
    expect(votes(omit(CLEAN, "audit.audit_fees_current")).auditor).toBe("REVIEW");
  });

  it("AGAINST beats REVIEW for the same item", () => {
    const f = { ...CLEAN, "board.independent_nominee_count": 3, "board.has_lead_independent_director": null };
    expect(decision(f, "nom_gov_chair")).toMatchObject({ vote: "AGAINST", firedRules: ["R1"], unknownRules: ["R2"] });
  });

  it("records the facts each rule used", () => {
    const f = { ...CLEAN };
    delete f["pay.peer_tsr_current"];
    const r4 = evaluatePolicy(GOLD_POLICY, f).rules.find((r) => r.ruleId === "R4")!;
    expect(r4.inputs).toEqual({
      "pay.ceo_total_comp_current": 12_000_000,
      "pay.ceo_total_comp_prior": 10_000_000,
      "pay.company_tsr_current": 180,
      "pay.peer_tsr_current": null,
    });
  });

  it("lists referenced facts", () => {
    expect(factsInExpr(GOLD_POLICY.rules[1].when)).toEqual(["board.ceo_is_chair", "board.has_lead_independent_director"]);
    expect(factsInPolicy(GOLD_POLICY)).toHaveLength(14);
    expect(formatRule(GOLD_POLICY.rules[1])).toBe(
      "R2 [nom_gov_chair] AGAINST if board.ceo_is_chair AND NOT board.has_lead_independent_director",
    );
  });
});

describe("valuesMatch", () => {
  it("applies per-unit tolerance", () => {
    expect(valuesMatch(true, true, "board.ceo_is_chair")).toBe(true);
    expect(valuesMatch(true, false, "board.ceo_is_chair")).toBe(false);
    expect(valuesMatch(9.4, 9, "board.nominee_count")).toBe(true);
    expect(valuesMatch(10, 9, "board.nominee_count")).toBe(false);
    expect(valuesMatch(1_004_000, 1_000_000, "audit.audit_fees_current")).toBe(true); // within 0.5%
    expect(valuesMatch(1_006_000, 1_000_000, "audit.audit_fees_current")).toBe(false);
    expect(valuesMatch(100.4, 100, "pay.company_tsr_current")).toBe(true); // 0.5 absolute floor
    expect(valuesMatch(0, 0.4, "audit.all_other_fees_current")).toBe(true);
    expect(valuesMatch(null, null, "pay.peer_tsr_current")).toBe(true);
    expect(valuesMatch(null, 0, "audit.all_other_fees_current")).toBe(false);
    expect(valuesMatch(0, null, "audit.all_other_fees_current")).toBe(false);
    expect(valuesMatch(1, true, "board.ceo_is_chair")).toBe(false);
  });
});

describe("consequentialFacts", () => {
  const gold: FactMap = { ...CLEAN };

  it("a wrong fact that flips a vote is consequential; one that doesn't is not", () => {
    const predicted: FactMap = {
      ...gold,
      "audit.tax_fees_current": 50_000_000, // flips auditor FOR -> AGAINST
      "board.independent_nominee_count": 8, // wrong, but 8/10 is still >= 2/3
    };
    expect(consequentialFacts(GOLD_POLICY, predicted, gold)).toEqual(["audit.tax_fees_current"]);
  });

  it("a missing prediction is consequential when it caused a REVIEW", () => {
    const predicted: FactMap = { ...gold, "pay.company_tsr_current": null };
    expect(consequentialFacts(GOLD_POLICY, predicted, gold)).toEqual(["pay.company_tsr_current"]);
  });

  it("values within tolerance and facts without gold are ignored", () => {
    const predicted: FactMap = { ...gold, "audit.audit_fees_current": 5_010_000 };
    expect(consequentialFacts(GOLD_POLICY, predicted, gold)).toEqual([]);
    const partialGold = omit(gold, "audit.tax_fees_current");
    expect(consequentialFacts(GOLD_POLICY, { ...gold, "audit.tax_fees_current": 50_000_000 }, partialGold)).toEqual([]);
  });

  it("votesMatch compares per item", () => {
    const a = evaluatePolicy(GOLD_POLICY, gold);
    const b = evaluatePolicy(GOLD_POLICY, { ...gold, "audit.tax_fees_current": 50_000_000 });
    expect(votesMatch(a, b)).toEqual({ nom_gov_chair: true, say_on_pay: true, auditor: false });
  });
});

describe("schema", () => {
  it("GOLD_POLICY parses and validates cleanly", () => {
    expect(PolicySchema.parse(GOLD_POLICY)).toEqual(GOLD_POLICY);
    expect(validatePolicy(GOLD_POLICY)).toEqual([]);
  });

  it("validatePolicy reports type and structure errors", () => {
    const bad = {
      id: "bad",
      name: "bad",
      text: "",
      rules: [
        { id: "X1", item: "say_on_pay", vote: "AGAINST", summary: "", when: { op: "fact", fact: "pay.ceo_total_comp_current" } },
        { id: "X2", item: "auditor", vote: "AGAINST", summary: "", when: { op: "and", args: [] } },
        {
          id: "X3",
          item: "board",
          vote: "AGAINST",
          summary: "",
          when: { op: "cmp", cmp: ">", left: { fact: "board.ceo_is_chair" }, right: { fact: "made.up" } },
        },
      ],
    } as unknown as Policy;
    const errors = validatePolicy(bad);
    expect(errors).toHaveLength(5);
    expect(errors.join("\n")).toMatch(/numeric fact "pay.ceo_total_comp_current" used as a condition/);
    expect(errors.join("\n")).toMatch(/"and" has no arguments/);
    expect(errors.join("\n")).toMatch(/item "board" is not a vote item/);
    expect(errors.join("\n")).toMatch(/boolean fact "board.ceo_is_chair" used as a numeric operand/);
    expect(errors.join("\n")).toMatch(/unknown fact "made.up"/);
  });

  it("wire encoding round-trips GOLD_POLICY through the LLM output schema", () => {
    const wire = { name: "gold", rules: GOLD_POLICY.rules.map(ruleToWire) };
    const parsed = CompiledPolicyOutputSchema.parse(JSON.parse(JSON.stringify(wire)));
    expect(parsed.rules).toEqual(GOLD_POLICY.rules);
  });

  it("LLM output schema rejects structurally incomplete trees with a readable error", () => {
    const wire = {
      name: "x",
      rules: [
        {
          id: "R1",
          item: "auditor",
          summary: "",
          when: { op: "not", args: [], fact: "", cmp: "", operands: [] },
        },
      ],
    };
    const res = CompiledPolicyOutputSchema.safeParse(wire);
    expect(res.success).toBe(false);
    expect(res.error?.issues[0].message).toMatch(/"not" needs exactly one expression/);
  });

  it("JSON schemas are strict-mode shaped", () => {
    for (const schema of [POLICY_JSON_SCHEMA, boundedPolicyJsonSchema()]) {
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (typeof node !== "object" || node === null) return;
        const o = node as Record<string, unknown>;
        if (o.type === "object") {
          expect(o.additionalProperties).toBe(false);
          expect([...(o.required as string[])].sort()).toEqual(Object.keys(o.properties as object).sort());
        }
        Object.values(o).forEach(walk);
      };
      walk(schema);
    }
    // The bounded variant has no self-references.
    const defs = boundedPolicyJsonSchema().$defs as Record<string, unknown>;
    for (const [name, def] of Object.entries(defs)) expect(JSON.stringify(def)).not.toContain(`/${name}"`);
  });
});
