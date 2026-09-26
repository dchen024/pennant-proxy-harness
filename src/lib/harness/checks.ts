import type { Chunk, CitationChecks, Extraction, FactDef, GoldFact, Stage } from "../types";

// Deterministic checks: no model judges whether a citation holds up.

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/\s*\|\s*/g, " ")
    .replace(/\$\s+/g, "$")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text: string): string[] {
  return (normalize(text).match(/[a-z0-9$][a-z0-9$.,%'-]*/g) ?? []).map((t) => t.replace(/[.,]+$/, ""));
}

/** Exact (normalized) containment, tolerating small drift like a dropped footnote marker: >=90% of quote tokens present. */
export function textContains(haystack: string, needle: string): boolean {
  const h = normalize(haystack);
  const n = normalize(needle);
  if (!n) return false;
  if (h.includes(n)) return true;
  const quoteTokens = tokens(n);
  if (quoteTokens.length < 3) return false;
  const have = new Set(tokens(h));
  return quoteTokens.filter((t) => have.has(t)).length / quoteTokens.length >= 0.9;
}

const NUM_RE = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(million|billion|thousand)?/gi;
/** A dash cell or "none" in a table stands for zero. */
const ZERO_CELL = /(^|[\s|$])[—–-](?=\s|\||$)|\bnone\b|\bnil\b/i;

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20,
};
const WORD_RE = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b`, "gi");

export function numbersIn(text: string): number[] {
  const out: number[] = [...text.matchAll(WORD_RE)].map((m) => NUMBER_WORDS[m[1].toLowerCase()]);
  for (const m of text.matchAll(NUM_RE)) {
    let n = Number.parseFloat(m[1].replace(/,/g, "") + (m[2] ? `.${m[2]}` : ""));
    const word = m[3]?.toLowerCase();
    if (word === "thousand") n *= 1e3;
    else if (word === "million") n *= 1e6;
    else if (word === "billion") n *= 1e9;
    out.push(n);
  }
  return out;
}

/** True if any candidate equals the value, allowing tables stated in thousands/millions/billions. */
export function numberMatches(value: number, candidates: number[]): boolean {
  const tol = Math.max(0.5, 0.005 * Math.abs(value));
  return candidates.some((n) => [1, 1e3, 1e6, 1e9].some((s) => Math.abs(n * s - value) <= tol));
}

/** Does any of these chunks contain the gold evidence (its quote, or for numbers the value itself)? */
export function evidenceIn(chunks: Pick<Chunk, "_id" | "text">[], gold: GoldFact, fact: FactDef): boolean {
  if (gold.quote && chunks.some((c) => textContains(c.text, gold.quote!))) return true;
  if (fact.type === "number" && typeof gold.value === "number") {
    const value = gold.value;
    if (chunks.some((c) => numberMatches(value, numbersIn(c.text)))) return true;
  }
  return gold.chunkId ? chunks.some((c) => c._id === gold.chunkId) : false;
}

export function citationChecks(
  ex: Extraction,
  cited: Chunk | undefined,
  fact: FactDef,
  gold: GoldFact | undefined,
): CitationChecks {
  // Quotes may come from the chunk body or its carried-over heading context (verbatim text of the
  // preceding chunk), so both still trace to the filing.
  const quoteInChunk = ex.quote
    ? Boolean(cited && (textContains(cited.text, ex.quote) || (cited.context && textContains(cited.context, ex.quote))))
    : null;
  let valueInQuote: boolean | null = null;
  if (fact.type === "number" && typeof ex.value === "number" && ex.quote) {
    const literal = numberMatches(ex.value, numbersIn(ex.quote)) || (ex.value === 0 && ZERO_CELL.test(ex.quote));
    // Counts are often derived ("all nominees other than the CEO are independent"): a checker can't
    // verify that arithmetic, so a count that isn't literally in the quote is "not checkable", not wrong.
    // Same for a 0 read from an absent row (JPM has no "All Other Fees" row; the rows sum to the total).
    valueInQuote = literal ? true : fact.unit === "count" || ex.value === 0 ? null : false;
  }
  return {
    quoteInChunk,
    valueInQuote,
    pageMatchesGold: gold?.page != null && cited ? cited.page === gold.page : null,
  };
}

/** Blame the first stage that went wrong: api → format → parse → retrieval → extraction; right answers can still fail citation. */
export function attribute(a: {
  apiError: boolean;
  malformed: boolean;
  extraction: Extraction | null;
  correct: boolean;
  checks: CitationChecks;
  evidenceInDoc: boolean;
  evidenceInContext: boolean;
}): Stage {
  if (a.apiError) return "api";
  if (a.malformed || !a.extraction) return "format";
  if (a.correct) {
    if (a.extraction.value === null) return "ok"; // correctly reported "not disclosed"
    const cited = a.checks.quoteInChunk === true && a.checks.valueInQuote !== false;
    return cited ? "ok" : "citation";
  }
  if (!a.evidenceInDoc) return "parse";
  if (!a.evidenceInContext) return "retrieval";
  return "extraction";
}
