import type { BBox, ChunkLine } from "./types";

/** Lowercase, unify quotes/dashes, drop table cell separators, collapse whitespace. */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−﹘﹣－]/g, "-")
    .replace(/[  -​  　]/g, " ")
    .replace(/\s*\|\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "its",
  "of", "on", "or", "our", "the", "their", "this", "that", "to", "was", "were", "with",
]);

/**
 * Content tokens: thousands separators removed so "$1,234,567" -> "1234567". One- and
 * two-digit numbers are dropped: they are mostly footnote markers like "(1)".
 */
function tokens(normalized: string): string[] {
  return normalized
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t) && !/^\d{1,2}$/.test(t));
}

/** Amounts and other figures; years are too common to anchor a match. */
const isSignificantNumber = (t: string) => /^\d{3,}$/.test(t) && !/^(19|20)\d{2}$/.test(t);

/** Splits a quote on ellipses so elided quotes still match line by line. */
function segments(normalizedQuote: string): string[] {
  return normalizedQuote
    .split(/\s*(?:\.\.\.|…)\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function lineMatchesQuote(lineText: string, quote: string): boolean {
  const nl = normalize(lineText);
  const nq = normalize(quote);
  if (!nl || !nq) return false;
  const lineTokens = [...new Set(tokens(nl))];
  if (lineTokens.length === 0) return false;

  for (const seg of segments(nq)) {
    // The line is (part of) the quote: require some substance so "2024" or "total" don't match.
    if (nl.length >= 8 && lineTokens.length >= 2 && seg.includes(nl)) return true;
    // The quote is a fragment of the line.
    if (seg.length >= 4 && nl.includes(seg)) return true;
  }

  const quoteTokens = new Set(tokens(nq));
  if (quoteTokens.size === 0) return false;
  const shared = lineTokens.filter((t) => quoteTokens.has(t));
  const overlap = shared.length;
  if (overlap === 0) return false;
  // A numeric row only matches a quote with figures if it shares one of them, so
  // neighbouring rows with the same label words (other years, other people) stay dark.
  if (
    [...quoteTokens].some(isSignificantNumber) &&
    lineTokens.some(isSignificantNumber) &&
    !shared.some(isSignificantNumber)
  ) {
    return false;
  }
  // Short lines (headings, labels) only match through exact containment above.
  const lineShare = lineTokens.length >= 4 ? overlap / lineTokens.length : 0;
  const quoteShare = quoteTokens.size >= 2 && lineTokens.length >= 2 ? overlap / quoteTokens.size : 0;
  return Math.max(lineShare, quoteShare) >= 0.6;
}

/** Normalized form used to locate a quote inside a chunk ("$ 135.0" and "$135.0" compare equal). */
const locate = (text: string) => normalize(text).replace(/\$\s+/g, "$");

/**
 * Which lines of a chunk a quote covers. Finds the quote's position in the chunk's continuous
 * text (each ellipsis-separated segment separately) and returns every line that span touches, so
 * a quote starting mid-line still lights its first line and a look-alike line elsewhere on the
 * page never does. If the quote isn't verbatim, falls back to the single best-matching run of
 * consecutive lines (token F1 >= 0.6); otherwise reports no match.
 */
export function quoteLineIndices(lines: ChunkLine[], quote: string | null | undefined): { indices: number[]; matched: boolean } {
  if (!lines?.length || !quote) return { indices: [], matched: false };
  const q = locate(quote);
  if (!q) return { indices: [], matched: false };

  const starts: number[] = [];
  const ends: number[] = [];
  let text = "";
  for (const l of lines) {
    const n = locate(l.text);
    starts.push(text.length);
    ends.push(text.length + n.length);
    text += `${n} `;
  }
  const hit = new Set<number>();
  for (const seg of segments(q)) {
    const at = text.indexOf(seg);
    if (at === -1) continue;
    lines.forEach((_, i) => {
      if (starts[i] < at + seg.length && ends[i] > at) hit.add(i);
    });
  }
  if (hit.size > 0) return { indices: [...hit].sort((a, b) => a - b), matched: true };

  const quoteTokens = new Set(tokens(q));
  if (quoteTokens.size === 0) return { indices: [], matched: false };
  let best = { f1: 0, from: -1, to: -1 };
  for (let from = 0; from < lines.length; from++) {
    const seen = new Set<string>();
    for (let to = from; to < Math.min(lines.length, from + 8); to++) {
      for (const t of tokens(locate(lines[to].text))) seen.add(t);
      if (seen.size === 0) continue;
      const recall = [...quoteTokens].filter((t) => seen.has(t)).length / quoteTokens.size;
      const precision = [...seen].filter((t) => quoteTokens.has(t)).length / seen.size;
      const f1 = recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0;
      if (f1 > best.f1) best = { f1, from, to };
    }
  }
  if (best.f1 >= 0.6) {
    return { indices: Array.from({ length: best.to - best.from + 1 }, (_, k) => best.from + k), matched: true };
  }
  return { indices: [], matched: false };
}

/**
 * Bounding boxes of the chunk lines that the quote covers. Falls back to every
 * line of the chunk when nothing matches (or there is no quote), so the
 * evidence region is always shown.
 */
export function linesForQuote(lines: ChunkLine[], quote: string | null | undefined): BBox[] {
  return matchQuote(lines, quote).boxes;
}

/** Like linesForQuote but also reports whether the quote actually matched. */
export function matchQuote(
  lines: ChunkLine[],
  quote: string | null | undefined,
): { boxes: BBox[]; matched: boolean } {
  if (!lines || lines.length === 0) return { boxes: [], matched: false };
  const { indices, matched } = quoteLineIndices(lines, quote);
  return matched ? { boxes: indices.map((i) => lines[i].bbox), matched } : { boxes: lines.map((l) => l.bbox), matched: false };
}
