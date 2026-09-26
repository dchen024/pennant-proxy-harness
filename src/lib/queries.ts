import "server-only";
import { collections } from "./db";
import { normalize } from "./highlight";
import type { Chunk, FactId, FactResult, FilingDoc, GoldFact, RunDoc } from "./types";

// Read-side data access for the UI. Every function degrades to an empty result
// when Mongo is not configured or unreachable, so pages can render an empty state.

export type DbStatus =
  | { ok: true }
  | { ok: false; kind: "no-uri" | "unreachable"; message: string };

/** A FactResult without the (large) raw model output; fetch the full doc on demand. */
export type ResultRow = Omit<FactResult, "raw"> & { raw?: string };

/** Filing fields the viewer needs (no parser metadata). */
export type FilingLite = Pick<
  FilingDoc,
  "_id" | "ticker" | "company" | "form" | "filingDate" | "sourceUrl" | "pdfPath" | "pages" | "accession" | "cik"
>;

/** Chunk fields needed to draw highlights. */
export type ChunkLite = Pick<Chunk, "_id" | "ticker" | "page" | "kind" | "lines" | "bbox">;

const CONNECT_TIMEOUT_MS = 8000;

class DbUnavailable extends Error {
  constructor(
    public kind: "no-uri" | "unreachable",
    message: string,
  ) {
    super(message);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new DbUnavailable("unreachable", `${label} timed out after ${ms / 1000}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function cols() {
  if (!process.env.MONGODB_URI) {
    throw new DbUnavailable("no-uri", "MONGODB_URI is not set. Add it to .env and restart the dev server.");
  }
  try {
    return await withTimeout(collections(), CONNECT_TIMEOUT_MS, "Connecting to MongoDB");
  } catch (err) {
    if (err instanceof DbUnavailable) throw err;
    // A rejected connect promise stays cached in db.ts; clear it so the next request retries.
    globalThis.__mongoClient = undefined;
    throw new DbUnavailable("unreachable", err instanceof Error ? err.message : String(err));
  }
}

async function safe<T>(label: string, fallback: T, fn: (c: Awaited<ReturnType<typeof collections>>) => Promise<T>): Promise<T> {
  try {
    const c = await cols();
    return await fn(c);
  } catch (err) {
    if (!(err instanceof DbUnavailable && err.kind === "no-uri")) {
      console.error(`[queries] ${label} failed:`, err instanceof Error ? err.message : err);
    }
    return fallback;
  }
}

export async function getDbStatus(): Promise<DbStatus> {
  try {
    await cols();
    return { ok: true };
  } catch (err) {
    if (err instanceof DbUnavailable) return { ok: false, kind: err.kind, message: err.message };
    return { ok: false, kind: "unreachable", message: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Runs and results
// ---------------------------------------------------------------------------

export function listRuns(limit = 50): Promise<RunDoc[]> {
  return safe("listRuns", [], (c) => c.runs.find({}).sort({ startedAt: -1 }).limit(limit).toArray());
}

export function getRun(id: string): Promise<RunDoc | null> {
  return safe("getRun", null, (c) => c.runs.findOne({ _id: id }));
}

/** Default run for the leaderboard: the latest done or running run. */
export async function getDefaultRun(runs?: RunDoc[]): Promise<RunDoc | null> {
  const list = runs ?? (await listRuns());
  return list.find((r) => r.status === "done" || r.status === "running") ?? list[0] ?? null;
}

/** Results for a run. Omits `raw` unless asked for, to keep polling payloads small. */
export function getResults(runId: string, opts: { withRaw?: boolean } = {}): Promise<ResultRow[]> {
  return safe("getResults", [], (c) =>
    c.results
      .find({ runId }, opts.withRaw ? {} : { projection: { raw: 0 } })
      .toArray() as Promise<ResultRow[]>,
  );
}

export function getResult(id: string): Promise<FactResult | null> {
  return safe("getResult", null, (c) => c.results.findOne({ _id: id }));
}

// ---------------------------------------------------------------------------
// Filings and chunks
// ---------------------------------------------------------------------------

const FILING_PROJECTION = {
  ticker: 1, company: 1, form: 1, filingDate: 1, sourceUrl: 1, pdfPath: 1, pages: 1, accession: 1, cik: 1,
} as const;

export function getFilings(): Promise<FilingLite[]> {
  return safe("getFilings", [], (c) =>
    c.filings.find({}, { projection: FILING_PROJECTION }).sort({ ticker: 1 }).toArray() as Promise<FilingLite[]>,
  );
}

export function getFiling(ticker: string): Promise<FilingLite | null> {
  return safe("getFiling", null, (c) =>
    c.filings.findOne({ _id: ticker }, { projection: FILING_PROJECTION }) as Promise<FilingLite | null>,
  );
}

/** Chunks by id, without embeddings. */
export function getChunks(ids: string[]): Promise<ChunkLite[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return Promise.resolve([]);
  return safe("getChunks", [], (c) =>
    c.chunks
      .find({ _id: { $in: unique } }, { projection: { ticker: 1, page: 1, kind: 1, lines: 1, bbox: 1 } })
      .toArray() as Promise<ChunkLite[]>,
  );
}

/** Trailing index of a chunk id: `${ticker}:p12:3` and `${ticker}:v3:p12:3` -> 3. */
function chunkIndex(id: string): number {
  const n = Number(id.slice(id.lastIndexOf(":") + 1));
  return Number.isFinite(n) ? n : 0;
}

/** Every chunk on one page for one parser version, in reading order (no embeddings). */
export function getPageChunks(ticker: string, page: number, parserVersion: string): Promise<ChunkLite[]> {
  return safe("getPageChunks", [], async (c) => {
    const rows = (await c.chunks
      .find({ ticker, page, parserVersion }, { projection: { ticker: 1, page: 1, kind: 1, lines: 1, bbox: 1 } })
      .toArray()) as ChunkLite[];
    return rows.sort((a, b) => chunkIndex(a._id) - chunkIndex(b._id));
  });
}

export interface SearchHit {
  chunkId: string;
  page: number;
  /** Inclusive range of chunk lines that contain the match. */
  lineStart: number;
  lineEnd: number;
  /** Original text of the matching lines (trimmed around the match when long). */
  snippet: string;
}

type SearchDoc = { _id: string; page: number; lines: { text: string }[] };
const SEARCH_TTL_MS = 5 * 60_000;
const searchCorpus = new Map<string, { at: number; docs: SearchDoc[] }>();

/** Search normalization: quotes, dashes, cell separators, whitespace, case; "74,294,811" matches "74294811". */
function searchNorm(text: string): string {
  return normalize(text)
    .replace(/\$\s+/g, "$")
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
}

function snippetAround(text: string, query: string): string {
  const MAX = 220;
  if (text.length <= MAX) return text;
  const at = text.toLowerCase().indexOf(query.trim().toLowerCase());
  const center = at >= 0 ? at + query.trim().length / 2 : 0;
  const start = Math.max(0, Math.min(text.length - MAX, Math.round(center - MAX / 2)));
  return `${start > 0 ? "…" : ""}${text.slice(start, start + MAX)}${start + MAX < text.length ? "…" : ""}`;
}

/**
 * Case- and punctuation-insensitive search over one filing's chunk text. Matches may span
 * lines of a chunk; each hit reports the line range so the UI can pre-select it.
 */
export async function searchChunks(
  ticker: string,
  query: string,
  parserVersion: string,
  limit = 15,
): Promise<{ hits: SearchHit[]; total: number }> {
  const q = searchNorm(query);
  if (q.length < 2) return { hits: [], total: 0 };
  return safe("searchChunks", { hits: [], total: 0 }, async (c) => {
    const key = `${ticker}:${parserVersion}`;
    let cached = searchCorpus.get(key);
    if (!cached || Date.now() - cached.at > SEARCH_TTL_MS) {
      const docs = (await c.chunks
        .find({ ticker, parserVersion }, { projection: { page: 1, "lines.text": 1 } })
        .toArray()) as unknown as SearchDoc[];
      docs.sort((a, b) => a.page - b.page || chunkIndex(a._id) - chunkIndex(b._id));
      cached = { at: Date.now(), docs };
      searchCorpus.set(key, cached);
    }

    const hits: SearchHit[] = [];
    let total = 0;
    for (const doc of cached.docs) {
      // Join the non-empty normalized lines with single spaces, remembering where each starts.
      const starts: { line: number; at: number }[] = [];
      let joined = "";
      doc.lines.forEach((l, i) => {
        const n = searchNorm(l.text);
        if (!n) return;
        if (joined) joined += " ";
        starts.push({ line: i, at: joined.length });
        joined += n;
      });
      let from = 0;
      for (;;) {
        const at = joined.indexOf(q, from);
        if (at < 0) break;
        total++;
        const end = at + q.length;
        if (hits.length < limit) {
          const first = [...starts].reverse().find((s) => s.at <= at) ?? starts[0];
          const last = [...starts].reverse().find((s) => s.at < end) ?? first;
          const text = doc.lines
            .slice(first.line, last.line + 1)
            .map((l) => l.text)
            .join(" ");
          hits.push({ chunkId: doc._id, page: doc.page, lineStart: first.line, lineEnd: last.line, snippet: snippetAround(text, query) });
        }
        from = end;
      }
    }
    return { hits, total };
  });
}

export function countChunks(): Promise<number> {
  return safe("countChunks", 0, (c) => c.chunks.estimatedDocumentCount());
}

// ---------------------------------------------------------------------------
// Answer key
// ---------------------------------------------------------------------------

export function listGold(ticker?: string): Promise<GoldFact[]> {
  return safe("listGold", [], (c) => c.gold.find(ticker ? { ticker } : {}).toArray());
}

export function getGold(ticker: string, factId: FactId): Promise<GoldFact | null> {
  return safe("getGold", null, (c) => c.gold.findOne({ ticker, factId }));
}

export function getGoldById(id: string): Promise<GoldFact | null> {
  return safe("getGoldById", null, (c) => c.gold.findOne({ _id: id }));
}

export async function updateGold(
  id: string,
  update: Partial<Pick<GoldFact, "value" | "status" | "chunkId" | "quote" | "page" | "note" | "evidenceBy">>,
): Promise<GoldFact | null> {
  const c = await cols();
  const res = await c.gold.findOneAndUpdate(
    { _id: id },
    { $set: { ...update, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" },
  );
  return res ?? null;
}
