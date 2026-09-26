import type { ModelSummary } from "@/lib/types";

export type SortKey =
  | "model"
  | "accuracy"
  | "graded"
  | "consequential"
  | "votes"
  | "citations"
  | "malformed"
  | "cost"
  | "latency";
export type SortDir = "asc" | "desc";
export interface SortState {
  key: SortKey;
  dir: SortDir;
}

/** First-click direction per column: "better" first. */
export const DEFAULT_DIR: Record<SortKey, SortDir> = {
  model: "asc",
  accuracy: "desc",
  graded: "desc",
  consequential: "asc",
  votes: "desc",
  citations: "desc",
  malformed: "asc",
  cost: "asc",
  latency: "asc",
};

export const DEFAULT_SORT: SortState = { key: "accuracy", dir: "desc" };

export const rowKey = (r: Pick<ModelSummary, "model" | "mode">) => `${r.model}::${r.mode}`;

/** >0 when a is more accurate than b; exact on correct/graded (no floating point). Ungraded rows sort last. */
export function compareAccuracy(a: ModelSummary, b: ModelSummary): number {
  if (!a.graded || !b.graded) return (a.graded ? 1 : 0) - (b.graded ? 1 : 0);
  return a.correct * b.graded - b.correct * a.graded;
}

export function sameAccuracy(a: ModelSummary, b: ModelSummary): boolean {
  if (!a.graded || !b.graded) return false;
  return compareAccuracy(a, b) === 0;
}

/** Default order: accuracy desc, then fewer vote-flipping errors, then cheaper, then name. */
export function defaultCompare(a: ModelSummary, b: ModelSummary): number {
  return (
    compareAccuracy(b, a) ||
    a.consequentialErrors - b.consequentialErrors ||
    a.costUsd - b.costUsd ||
    a.model.localeCompare(b.model)
  );
}

function value(r: ModelSummary, key: SortKey): number | string | null {
  switch (key) {
    case "model":
      return r.model;
    case "accuracy":
      return r.graded ? r.correct / r.graded : null;
    case "graded":
      return r.graded;
    case "consequential":
      return r.consequentialErrors;
    case "votes":
      return r.votesTotal > 0 ? r.votesCorrect / r.votesTotal : null;
    case "citations":
      return r.citationValid;
    case "malformed":
      return r.malformed;
    case "cost":
      return r.costUsd;
    case "latency":
      return r.avgLatencyMs;
  }
}

/** Sorts by one column (nulls last either way); ties fall back to the default order. */
export function sortRows(rows: ModelSummary[], sort: SortState): ModelSummary[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sort.key === "accuracy") {
      const c = compareAccuracy(a, b); // >0: a is more accurate
      return c !== 0 ? sign * c : defaultCompare(a, b);
    }
    const va = value(a, sort.key);
    const vb = value(b, sort.key);
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1;
      return defaultCompare(a, b);
    }
    const c = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
    return c !== 0 ? sign * c : defaultCompare(a, b);
  });
}

/** Competition ranks by accuracy ("1=", "1=", "3") within one mode's rows. */
export function accuracyRanks(rows: ModelSummary[]): Map<string, { rank: number | null; tiedWith: ModelSummary[] }> {
  const out = new Map<string, { rank: number | null; tiedWith: ModelSummary[] }>();
  for (const r of rows) {
    if (!r.graded) {
      out.set(rowKey(r), { rank: null, tiedWith: [] });
      continue;
    }
    const better = rows.filter((o) => o.graded && compareAccuracy(o, r) > 0).length;
    out.set(rowKey(r), { rank: better + 1, tiedWith: rows.filter((o) => o !== r && sameAccuracy(o, r)) });
  }
  return out;
}

/** "A", "A & B", "A, B & C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

/** Most common graded count (the answer-key size the run was scored on). */
export function typicalGraded(rows: ModelSummary[]): number {
  const counts = new Map<number, number>();
  for (const r of rows) if (r.graded) counts.set(r.graded, (counts.get(r.graded) ?? 0) + 1);
  let best = 0;
  let n = 0;
  for (const [g, c] of counts) if (c > n || (c === n && g > best)) [best, n] = [g, c];
  return best;
}
