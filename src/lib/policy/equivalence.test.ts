import { describe, expect, it } from "vitest";
import type { Expr, FactMap, Policy } from "../types";
import { compareTrees, mulberry32, randomFacts } from "./equivalence";
import { evaluatePolicy, VOTE_ITEMS, votesOf } from "./evaluate";
import { GOLD_POLICY } from "./policy";

function mutate(edit: (p: Policy) => void): Policy {
  const p = structuredClone(GOLD_POLICY);
  p.id = "mutant";
  edit(p);
  return p;
}

const setWhen = (p: Policy, ruleId: string, when: Expr) => {
  p.rules.find((r) => r.id === ruleId)!.when = when;
};

describe("compareTrees", () => {
  it("GOLD vs itself agrees everywhere", () => {
    const r = compareTrees(GOLD_POLICY, structuredClone(GOLD_POLICY));
    expect(r.samples).toBe(2000);
    expect(r.agreement).toBe(1);
    expect(r.byItem).toEqual({ nom_gov_chair: 1, say_on_pay: 1, auditor: 1 });
    expect(r.disagreements).toEqual([]);
  });

  it("detects a wrong R1 threshold and a missing NOT in R2", () => {
    const mutant = mutate((p) => {
      setWhen(p, "R1", {
        op: "cmp",
        cmp: "<",
        left: { op: "div", left: { fact: "board.independent_nominee_count" }, right: { fact: "board.nominee_count" } },
        right: { const: 0.5 },
      });
      setWhen(p, "R2", {
        op: "and",
        args: [
          { op: "fact", fact: "board.ceo_is_chair" },
          { op: "fact", fact: "board.has_lead_independent_director" },
        ],
      });
    });
    const r = compareTrees(GOLD_POLICY, mutant);
    expect(r.agreement).toBeLessThan(1);
    expect(r.byItem.nom_gov_chair).toBeLessThan(1);
    expect(r.byItem.say_on_pay).toBe(1);
    expect(r.byItem.auditor).toBe(1);
    expect(r.disagreements.length).toBeGreaterThan(0);
    expect(r.disagreements.length).toBeLessThanOrEqual(5);
    for (const d of r.disagreements) {
      // The reported votes are real and differ on nom_gov_chair only.
      expect(VOTE_ITEMS.map((i) => votesOf(evaluatePolicy(GOLD_POLICY, d.facts))[i])).toEqual(d.a);
      expect(VOTE_ITEMS.map((i) => votesOf(evaluatePolicy(mutant, d.facts))[i])).toEqual(d.b);
      expect(d.a[0]).not.toBe(d.b[0]);
      expect(d.a.slice(1)).toEqual(d.b.slice(1));
    }
  });

  it("catches an off-by-tie comparison (<= instead of <) via exact threshold samples", () => {
    const mutant = mutate((p) => {
      const r1 = p.rules.find((r) => r.id === "R1")!.when as Extract<Expr, { op: "cmp" }>;
      r1.cmp = "<=";
    });
    const r = compareTrees(GOLD_POLICY, mutant);
    expect(r.byItem.nom_gov_chair).toBeLessThan(1);
    for (const d of r.disagreements) {
      const f = d.facts;
      expect((f["board.independent_nominee_count"] as number) / (f["board.nominee_count"] as number)).toBe(2 / 3);
    }
  });

  it("treats equivalent encodings as equivalent (3*independent < 2*nominees, De Morgan)", () => {
    const mutant = mutate((p) => {
      setWhen(p, "R1", {
        op: "cmp",
        cmp: "<",
        left: { op: "mul", left: { const: 3 }, right: { fact: "board.independent_nominee_count" } },
        right: { op: "mul", left: { const: 2 }, right: { fact: "board.nominee_count" } },
      });
      setWhen(p, "R3", {
        op: "not",
        arg: {
          op: "or",
          args: [
            { op: "not", arg: { op: "fact", fact: "governance.unequal_voting_rights" } },
            { op: "fact", fact: "governance.unequal_voting_sunset" },
          ],
        },
      });
    });
    expect(compareTrees(GOLD_POLICY, mutant).agreement).toBe(1);
  });

  it("is deterministic for a seed", () => {
    const mutant = mutate((p) => {
      p.rules = p.rules.filter((r) => r.id !== "R5");
    });
    const a = compareTrees(GOLD_POLICY, mutant, 500, 7);
    const b = compareTrees(GOLD_POLICY, mutant, 500, 7);
    expect(a).toEqual(b);
    expect(a.samples).toBe(500);
    expect(a.byItem.auditor).toBeLessThan(1);
  });
});

describe("randomFacts", () => {
  it("includes exact ties and missing facts at roughly the configured rates", () => {
    const rng = mulberry32(123);
    const samples: FactMap[] = Array.from({ length: 4000 }, () => randomFacts(rng));
    const withNull = samples.filter((f) => Object.values(f).some((v) => v === null)).length;
    const r1Ties = samples.filter(
      (f) => (f["board.independent_nominee_count"] as number) * 3 === (f["board.nominee_count"] as number) * 2,
    ).length;
    const feeTies = samples.filter(
      (f) =>
        (f["audit.tax_fees_current"] as number) + (f["audit.all_other_fees_current"] as number) ===
        (f["audit.audit_fees_current"] as number) + (f["audit.audit_related_fees_current"] as number),
    ).length;
    expect(withNull / samples.length).toBeGreaterThan(0.03);
    expect(withNull / samples.length).toBeLessThan(0.07);
    expect(r1Ties).toBeGreaterThan(100);
    expect(feeTies).toBeGreaterThan(100);
    for (const f of samples) {
      const n = f["board.nominee_count"];
      if (typeof n !== "number") continue; // the occasional missing fact
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(16);
    }
  });
});
