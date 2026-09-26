import type { FactResult, Mode, ModelSummary, Stage } from "@/lib/types";

type ResultLike = Omit<FactResult, "raw"> & { raw?: string };

export const colKey = (model: string, mode: Mode) => `${model}::${mode}`;

/** Citation passes when the quote is in the chunk and no check fails outright. */
export function citationPasses(r: ResultLike): boolean {
  const c = r.checks;
  if (!c) return false;
  return c.quoteInChunk === true && c.valueInQuote !== false && c.pageMatchesGold !== false;
}

/**
 * Provisional per-model summary computed from results (used while a run is still
 * going, before the harness writes run.summary). Votes need the policy engine, so
 * they are left at 0/0 and shown as "—".
 */
export function summarize(results: ResultLike[]): ModelSummary[] {
  const groups = new Map<string, ResultLike[]>();
  for (const r of results) {
    const k = colKey(r.model, r.mode);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const out: ModelSummary[] = [];
  for (const rows of groups.values()) {
    const graded = rows.filter((r) => r.hasGold && r.correct !== null);
    const correct = graded.filter((r) => r.correct === true).length;
    const answered = rows.filter((r) => r.extraction && r.extraction.value !== null);
    const byStage: Partial<Record<Stage, number>> = {};
    for (const r of rows) if (r.stage) byStage[r.stage] = (byStage[r.stage] ?? 0) + 1;
    const cost = rows.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    out.push({
      model: rows[0].model,
      mode: rows[0].mode,
      facts: rows.length,
      graded: graded.length,
      correct,
      accuracy: graded.length ? correct / graded.length : null,
      consequentialErrors: rows.filter((r) => r.consequential === true).length,
      votesCorrect: 0,
      votesTotal: 0,
      citationValid: answered.length ? answered.filter(citationPasses).length / answered.length : 0,
      malformed: rows.filter((r) => r.stage === "format" || (!r.extraction && !r.error)).length,
      byStage,
      costUsd: cost,
      avgLatencyMs: rows.length ? rows.reduce((s, r) => s + (r.latencyMs ?? 0), 0) / rows.length : 0,
    });
  }
  return sortSummaries(out);
}

export function sortSummaries(rows: ModelSummary[]): ModelSummary[] {
  const modeRank = (m: string) => (m === "e2e" ? 0 : 1);
  return [...rows].sort(
    (a, b) =>
      modeRank(a.mode) - modeRank(b.mode) ||
      (b.accuracy ?? -1) - (a.accuracy ?? -1) ||
      a.consequentialErrors - b.consequentialErrors ||
      a.costUsd - b.costUsd ||
      a.model.localeCompare(b.model),
  );
}
