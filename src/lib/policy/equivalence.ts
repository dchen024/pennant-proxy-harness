// Behavioural equivalence of two policies by randomized testing: same facts in, same votes out?

import { FACTS } from "../facts";
import type { FactId, FactMap, Policy, Vote, VoteItem } from "../types";
import { evaluatePolicy, factsInPolicy, VOTE_ITEMS, votesOf } from "./evaluate";

export interface Disagreement {
  facts: FactMap;
  /** Votes in VOTE_ITEMS order: [nom_gov_chair, say_on_pay, auditor]. */
  a: Vote[];
  b: Vote[];
}

export interface EquivalenceReport {
  /** Fraction of samples on which every item's vote agrees. */
  agreement: number;
  samples: number;
  /** Up to 5 examples, distinct vote patterns first. */
  disagreements: Disagreement[];
  /** Per-item fraction of samples with the same vote. */
  byItem: Record<VoteItem, number>;
}

/** Small, fast, seedable PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TIE_RATE = 0.1;
const MISSING_RATE = 0.05;

/**
 * One random fact set. Booleans fair coins; counts 3-16 (independent nominees <= nominees);
 * usd log-uniform 1e5-1e9; index 30-500. ~10% of samples get exact threshold ties
 * (independent = 2/3 of nominees, pay current == prior, company TSR == peer TSR,
 * non-audit fees == audit + audit-related); ~5% get one fact from `missingCandidates` set to null.
 */
export function randomFacts(rng: () => number, missingCandidates: readonly FactId[] = FACTS.map((f) => f.id)): FactMap {
  const int = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  const usd = () => Math.round(Math.exp(Math.log(1e5) + rng() * Math.log(1e4)));
  const index = () => Math.round((30 + rng() * 470) * 100) / 100;

  const f: FactMap = {};
  for (const def of FACTS) {
    if (def.type === "boolean") f[def.id] = rng() < 0.5;
    else if (def.unit === "count") f[def.id] = int(3, 16);
    else if (def.unit === "usd") f[def.id] = usd();
    else f[def.id] = index();
  }
  const nominees = f["board.nominee_count"] as number;
  f["board.independent_nominee_count"] = int(0, nominees);

  if (rng() < TIE_RATE) {
    const ties: Array<() => void> = [
      () => {
        const n = 3 * int(1, 5);
        f["board.nominee_count"] = n;
        f["board.independent_nominee_count"] = (2 * n) / 3;
      },
      () => {
        f["pay.ceo_total_comp_prior"] = f["pay.ceo_total_comp_current"];
      },
      () => {
        f["pay.peer_tsr_current"] = f["pay.company_tsr_current"];
      },
      () => {
        const sum = (f["audit.audit_fees_current"] as number) + (f["audit.audit_related_fees_current"] as number);
        const tax = Math.round(sum * rng());
        f["audit.tax_fees_current"] = tax;
        f["audit.all_other_fees_current"] = sum - tax;
      },
    ];
    // Each tie independently with p=0.5 (at least one), so a tie is not always masked by another.
    const chosen = ties.filter(() => rng() < 0.5);
    for (const apply of chosen.length > 0 ? chosen : [ties[int(0, ties.length - 1)]]) apply();
  }

  if (missingCandidates.length > 0 && rng() < MISSING_RATE) {
    f[missingCandidates[int(0, missingCandidates.length - 1)]] = null;
  }
  return f;
}

/** Compare two policies' votes on `samples` random fact sets (deterministic for a given seed). */
export function compareTrees(a: Policy, b: Policy, samples = 2000, seed = 1): EquivalenceReport {
  const rng = mulberry32(seed);
  const relevant = [...new Set([...factsInPolicy(a), ...factsInPolicy(b)])];
  const itemAgree = Object.fromEntries(VOTE_ITEMS.map((i) => [i, 0])) as Record<VoteItem, number>;
  let allAgree = 0;
  const distinct: Disagreement[] = [];
  const repeats: Disagreement[] = [];
  const patterns = new Set<string>();

  for (let s = 0; s < samples; s++) {
    const facts = randomFacts(rng, relevant);
    const va = votesOf(evaluatePolicy(a, facts));
    const vb = votesOf(evaluatePolicy(b, facts));
    let same = true;
    for (const item of VOTE_ITEMS) {
      if (va[item] === vb[item]) itemAgree[item]++;
      else same = false;
    }
    if (same) {
      allAgree++;
      continue;
    }
    const d: Disagreement = { facts, a: VOTE_ITEMS.map((i) => va[i]), b: VOTE_ITEMS.map((i) => vb[i]) };
    const pattern = `${d.a.join()}|${d.b.join()}`;
    if (!patterns.has(pattern) && distinct.length < 5) {
      patterns.add(pattern);
      distinct.push(d);
    } else if (repeats.length < 5) {
      repeats.push(d);
    }
  }

  const frac = (n: number) => (samples > 0 ? n / samples : 1);
  const byItem = Object.fromEntries(VOTE_ITEMS.map((i) => [i, frac(itemAgree[i])])) as Record<VoteItem, number>;
  return { agreement: frac(allAgree), samples, disagreements: [...distinct, ...repeats].slice(0, 5), byItem };
}
