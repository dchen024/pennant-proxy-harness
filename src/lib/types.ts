// Shared contracts for ingestion, extraction, the policy engine, the harness and the UI.

export const FACT_IDS = [
  "board.nominee_count",
  "board.independent_nominee_count",
  "board.ceo_is_chair",
  "board.has_lead_independent_director",
  "governance.unequal_voting_rights",
  "governance.unequal_voting_sunset",
  "pay.ceo_total_comp_current",
  "pay.ceo_total_comp_prior",
  "pay.company_tsr_current",
  "pay.peer_tsr_current",
  "audit.audit_fees_current",
  "audit.audit_related_fees_current",
  "audit.tax_fees_current",
  "audit.all_other_fees_current",
] as const;

export type FactId = (typeof FACT_IDS)[number];
export type FactType = "number" | "boolean";
export type FactValue = number | boolean | null;
export type FactMap = Partial<Record<FactId, FactValue>>;

export interface FactDef {
  id: FactId;
  type: FactType;
  unit?: "usd" | "count" | "index";
  label: string;
  /** Precise definition shown to the extraction model. */
  description: string;
  /** Text embedded to retrieve candidate chunks. */
  query: string;
}

/** [x0, y0, x1, y1] in PDF points, top-left origin, relative to the page. */
export type BBox = [number, number, number, number];

export interface PageDim {
  page: number; // 1-based
  width: number;
  height: number;
}

export interface FilingDoc {
  _id: string; // ticker
  ticker: string;
  company: string;
  cik: string;
  form: string; // "DEF 14A"
  accession: string;
  filingDate: string; // YYYY-MM-DD
  sourceUrl: string; // EDGAR primary document
  pdfPath: string; // public URL path, e.g. "/filings/AAPL.pdf"
  pages: PageDim[];
  parserVersion: string;
}

export interface ChunkLine {
  text: string;
  bbox: BBox;
}

export interface Chunk {
  _id: string; // `${ticker}:p${page}:${index}`
  ticker: string;
  page: number; // 1-based
  kind: "text" | "table";
  text: string; // lines joined by "\n"; table cells separated by " | "
  lines: ChunkLine[];
  bbox: BBox;
  /** v3+: heading/intro lines that precede this chunk (e.g. a table's title). Embedded and shown to the model, never quoted. */
  context?: string;
  embedding?: number[];
  parserVersion: string;
}

export interface GoldProposal {
  model: string;
  value: FactValue;
  chunkId: string | null;
  quote: string | null;
}

export interface GoldFact {
  _id: string; // `${ticker}:${factId}`
  ticker: string;
  factId: FactId;
  value: FactValue;
  page: number | null;
  quote: string | null;
  chunkId: string | null;
  /** proposed = drafting models agree; disputed = they disagree; verified = a human confirmed it. */
  status: "proposed" | "disputed" | "verified";
  /** Who chose the evidence: a drafting model (default), a curator, or the human reviewer. */
  evidenceBy?: "draft" | "curated" | "reviewer";
  proposals: GoldProposal[];
  note?: string;
  updatedAt: string;
}

export interface Extraction {
  value: FactValue;
  chunkId: string | null;
  quote: string | null;
  fiscalYear: number | null;
}

export interface CitationChecks {
  /** The quote appears (normalized) in the cited chunk. null = no quote given. */
  quoteInChunk: boolean | null;
  /** A number in the quote matches the extracted value (allowing thousands/millions scaling). null = boolean fact or no quote. */
  valueInQuote: boolean | null;
  /** The cited chunk is on the same page as the gold evidence. null = no gold page. */
  pageMatchesGold: boolean | null;
}

/** The first pipeline stage that went wrong for a fact (attribution). */
export type Stage =
  | "ok"
  | "parse" // gold evidence is not present in any parsed chunk
  | "retrieval" // gold evidence exists but was not in the retrieved context
  | "extraction" // evidence was in context but the value is wrong
  | "citation" // value right, but the citation doesn't support it
  | "format" // output could not be parsed into the schema
  | "api"; // provider/API error or timeout

export type Mode = "e2e" | "oracle";

export interface FactResult {
  _id: string; // `${runId}:${model}:${mode}:${ticker}:${factId}`
  runId: string;
  model: string;
  mode: Mode;
  ticker: string;
  factId: FactId;
  retrievedChunkIds: string[];
  extraction: Extraction | null;
  raw: string;
  gold: FactValue | null;
  hasGold: boolean;
  correct: boolean | null;
  checks: CitationChecks;
  stage: Stage | null; // null when there is no gold to attribute against
  consequential: boolean | null;
  costUsd: number | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  repaired: boolean;
  malformed?: boolean;
  error?: string;
  routedModel?: string;
  createdAt: string;
}

export interface ModelSummary {
  model: string;
  mode: Mode;
  facts: number;
  graded: number;
  correct: number;
  accuracy: number | null;
  consequentialErrors: number;
  votesCorrect: number;
  votesTotal: number;
  citationValid: number; // fraction of answered facts whose citation checks all pass
  malformed: number;
  byStage: Partial<Record<Stage, number>>;
  costUsd: number;
  avgLatencyMs: number;
}

export interface RunDoc {
  _id: string;
  label?: string;
  models: string[];
  modes: Mode[];
  tickers: string[];
  factIds: FactId[];
  status: "running" | "done" | "error";
  progress: { done: number; total: number };
  startedAt: string;
  finishedAt?: string;
  error?: string;
  summary?: ModelSummary[];
  gradedWith?: "verified" | "any";
  gradedAt?: string;
  config: { retrievalK: number; parserVersion: string; promptVersion: string; retrieval?: string };
}

/** Retrieval results are cached per company x fact so every model sees identical context. */
export interface RetrievalCache {
  _id: string; // `${ticker}:${factId}:${k}:${parserVersion}`
  ticker: string;
  factId: FactId;
  k: number;
  chunkIds: string[];
  scores: number[];
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Policy engine: a voting policy compiled into boolean expression trees.
// ---------------------------------------------------------------------------

export type Operand =
  | { fact: FactId }
  | { const: number }
  | { op: "add" | "sub" | "mul" | "div"; left: Operand; right: Operand };

export type Expr =
  | { op: "and" | "or"; args: Expr[] }
  | { op: "not"; arg: Expr }
  | { op: "fact"; fact: FactId } // boolean fact used as a condition
  | { op: "cmp"; cmp: "<" | "<=" | ">" | ">=" | "==" | "!="; left: Operand; right: Operand };

export type VoteItem = "nom_gov_chair" | "say_on_pay" | "auditor";
export type Vote = "FOR" | "AGAINST" | "REVIEW";

export interface PolicyRule {
  id: string;
  item: VoteItem;
  vote: "AGAINST";
  when: Expr;
  summary: string;
}

export interface Policy {
  id: string;
  name: string;
  text: string;
  rules: PolicyRule[];
}

/** Kleene three-valued logic: null = unknown (a needed fact is missing). */
export type Tri = boolean | null;

export interface RuleEvaluation {
  ruleId: string;
  item: VoteItem;
  fired: Tri;
  /** Facts the rule depends on, with the values used. */
  inputs: Partial<Record<FactId, FactValue>>;
}

export interface ItemDecision {
  item: VoteItem;
  vote: Vote;
  firedRules: string[];
  unknownRules: string[];
}

export interface PolicyEvaluation {
  decisions: ItemDecision[];
  rules: RuleEvaluation[];
}
