import pLimit from "p-limit";
import { CONCURRENCY, PARSER_VERSION, PROMPT_VERSION, RETRIEVAL_K, RETRIEVAL_STRATEGY, type RetrievalStrategy } from "../config";
import { collections } from "../db";
import { FACTS, FACT_BY_ID } from "../facts";
import { GOLD_POLICY } from "../policy/policy";
import { evaluatePolicy, factsInExpr, valuesMatch } from "../policy/evaluate";
import type { Chunk, FactId, FactMap, FactResult, GoldFact, Mode, ModelSummary, RunDoc, Stage } from "../types";
import { assertWritable } from "../readonly";
import { attribute, citationChecks, evidenceIn, textContains } from "./checks";
import { extractFact } from "./extract";
import { retrieve } from "./retrieve";

export type GradeWith = "verified" | "any";

export interface RunOptions {
  models: string[];
  modes: Mode[];
  tickers?: string[];
  factIds?: FactId[];
  label?: string;
  /** "verified" grades only against human-verified answers; "any" also uses agreed drafts (dev only). */
  gradeWith?: GradeWith;
  /** Which parsed version of the filings to run against (for before/after parser comparisons). */
  parserVersion?: string;
  /** Retrieval strategy (vector-only or hybrid keyword + vector). */
  retrieval?: RetrievalStrategy;
  /** An approved config (extra prompt rules, clarified definitions, search queries) to run with. */
  configId?: string;
}

const now = () => new Date().toISOString();

/** Creates the run document and executes it in the background. Returns the run id immediately. */
export async function startRun(opts: RunOptions): Promise<string> {
  assertWritable("starting a run");
  const runId = await createRun(opts);
  void executeRun(runId, opts).catch(async (err) => {
    const c = await collections();
    await c.runs.updateOne({ _id: runId }, { $set: { status: "error", error: String(err?.message ?? err), finishedAt: now() } });
  });
  return runId;
}

/** Runs to completion (CLI). */
export async function runToCompletion(opts: RunOptions, onProgress?: (done: number, total: number) => void) {
  const runId = await createRun(opts);
  await executeRun(runId, opts, onProgress);
  const c = await collections();
  return (await c.runs.findOne({ _id: runId }))!;
}

async function createRun(opts: RunOptions): Promise<string> {
  const c = await collections();
  const tickers = opts.tickers?.length ? opts.tickers : (await c.filings.find({}, { projection: { _id: 1 } }).toArray()).map((f) => f._id);
  const factIds = opts.factIds?.length ? opts.factIds : FACTS.map((f) => f.id);
  opts.tickers = tickers;
  opts.factIds = factIds;
  const runId = `run_${now().replace(/[-:T]/g, "").slice(0, 14)}_${Math.random().toString(36).slice(2, 6)}`;
  const run: RunDoc = {
    _id: runId,
    label: opts.label,
    models: opts.models,
    modes: opts.modes,
    tickers,
    factIds,
    status: "running",
    progress: { done: 0, total: opts.models.length * opts.modes.length * tickers.length * factIds.length },
    startedAt: now(),
    config: {
      retrievalK: RETRIEVAL_K,
      parserVersion: opts.parserVersion ?? PARSER_VERSION,
      promptVersion: opts.configId ?? PROMPT_VERSION,
      retrieval: opts.retrieval ?? RETRIEVAL_STRATEGY,
    },
  };
  await c.runs.insertOne(run);
  return runId;
}

async function loadGold(tickers: string[], gradeWith: GradeWith | "all") {
  const c = await collections();
  const statuses: GoldFact["status"][] =
    gradeWith === "all" ? ["verified", "proposed", "disputed"] : gradeWith === "any" ? ["verified", "proposed"] : ["verified"];
  const docs = await c.gold.find({ ticker: { $in: tickers }, status: { $in: statuses } }).toArray();
  return new Map<string, GoldFact>(docs.map((g) => [`${g.ticker}:${g.factId}`, g]));
}

async function loadChunks(tickers: string[], parserVersion: string) {
  const c = await collections();
  const docChunks = new Map<string, Chunk[]>();
  for (const t of tickers) docChunks.set(t, await c.chunks.find({ ticker: t, parserVersion }, { projection: { embedding: 0 } }).toArray());
  const chunkById = new Map([...docChunks.values()].flat().map((ch) => [ch._id, ch]));
  return { docChunks, chunkById };
}

/** Inference only: every model answers every fact. Grading happens afterwards in gradeRun. */
async function executeRun(runId: string, opts: RunOptions, onProgress?: (done: number, total: number) => void) {
  const c = await collections();
  const tickers = opts.tickers!;
  const factIds = opts.factIds!;
  const parserVersion = opts.parserVersion ?? PARSER_VERSION;
  const gold = await loadGold(tickers, opts.gradeWith ?? "verified");
  // Oracle context uses the best evidence we have (drafted or verified); grading still uses only `gold`.
  const evidence = await loadGold(tickers, "all");
  const { docChunks, chunkById } = await loadChunks(tickers, parserVersion);
  const companies = new Map((await c.filings.find({ _id: { $in: tickers } }).toArray()).map((f) => [f._id, f.company]));
  const cfg = opts.configId ? await c.configs.findOne({ _id: opts.configId }) : null;
  if (opts.configId && !cfg) throw new Error(`config ${opts.configId} not found`);

  const total = opts.models.length * opts.modes.length * tickers.length * factIds.length;
  let done = 0;
  const limit = pLimit(CONCURRENCY);
  const jobs: Promise<void>[] = [];

  for (const model of opts.models)
    for (const mode of opts.modes)
      for (const ticker of tickers)
        for (const factId of factIds)
          jobs.push(
            limit(async () => {
              const e = evidence.get(`${ticker}:${factId}`);
              const goldChunk = e ? resolveGoldChunk(e, chunkById, docChunks.get(ticker)!) : undefined;
              // Oracle mode hands the model the gold evidence directly: isolates reading from retrieval.
              const context =
                mode === "oracle" && goldChunk
                  ? [goldChunk]
                  : await retrieve(ticker, factId, RETRIEVAL_K, parserVersion, opts.retrieval ?? RETRIEVAL_STRATEGY, cfg?.factQueries[factId]);
              const overrides = cfg ? { systemAppend: cfg.systemAppend, description: cfg.factDescriptions[factId] } : undefined;
              const call = await extractFact({ model, company: companies.get(ticker) ?? ticker, ticker, factId, chunks: context, overrides });

              const result: FactResult = {
                _id: `${runId}:${model}:${mode}:${ticker}:${factId}`,
                runId, model, mode, ticker, factId,
                retrievedChunkIds: context.map((ch) => ch._id),
                extraction: call.data,
                raw: call.raw,
                gold: null,
                hasGold: false,
                correct: null,
                checks: { quoteInChunk: null, valueInQuote: null, pageMatchesGold: null },
                stage: null,
                consequential: null,
                costUsd: call.costUsd,
                latencyMs: call.latencyMs,
                inputTokens: call.inputTokens,
                outputTokens: call.outputTokens,
                repaired: call.repaired,
                ...(call.malformed ? { malformed: true } : {}),
                ...(call.error ? { error: call.error } : {}),
                ...(call.routedModel && call.routedModel !== model ? { routedModel: call.routedModel } : {}),
                createdAt: now(),
              };
              gradeOne(result, gold, docChunks, chunkById); // provisional; gradeRun re-grades everything at the end
              await c.results.replaceOne({ _id: result._id }, result, { upsert: true });
              done++;
              onProgress?.(done, total);
              await c.runs.updateOne({ _id: runId }, { $set: { "progress.done": done } });
            }),
          );
  await Promise.all(jobs);
  await gradeRun(runId, opts.gradeWith ?? "verified");
  await c.runs.updateOne({ _id: runId }, { $set: { status: "done", finishedAt: now(), "progress.done": total } });
}

/** Re-runs some modes of an existing run in place (e.g. after a harness fix), then re-grades the whole run. */
export async function rerunModes(runId: string, modes: Mode[], onProgress?: (done: number, total: number) => void) {
  const c = await collections();
  const run = await c.runs.findOne({ _id: runId });
  if (!run) throw new Error(`run ${runId} not found`);
  const total = run.models.length * modes.length * run.tickers.length * run.factIds.length;
  await c.runs.updateOne({ _id: runId }, { $set: { status: "running", progress: { done: 0, total } } });
  await executeRun(
    runId,
    {
      models: run.models,
      modes,
      tickers: run.tickers,
      factIds: run.factIds,
      parserVersion: run.config.parserVersion,
      retrieval: (run.config.retrieval as RetrievalStrategy | undefined) ?? RETRIEVAL_STRATEGY,
      gradeWith: run.gradedWith ?? "verified",
    },
    onProgress,
  );
  return (await c.runs.findOne({ _id: runId }))!;
}

/**
 * Grades stored answers against the current answer key: citation checks, stage attribution,
 * consequential errors, votes and per-model summaries. Deterministic and free: re-run it whenever
 * the answer key or the checkers change, without calling any model again.
 */
export async function gradeRun(runId: string, gradeWith: GradeWith = "verified"): Promise<RunDoc> {
  const c = await collections();
  const run = await c.runs.findOne({ _id: runId });
  if (!run) throw new Error(`run ${runId} not found`);
  const gold = await loadGold(run.tickers, gradeWith);
  const { docChunks, chunkById } = await loadChunks(run.tickers, run.config.parserVersion);
  const results = await c.results.find({ runId }).toArray();

  for (const r of results) gradeOne(r, gold, docChunks, chunkById);

  // Votes and consequential errors: the policy tree is evaluated in code on predicted vs gold facts.
  const summary: ModelSummary[] = [];
  for (const model of run.models)
    for (const mode of run.modes) {
      const mine = results.filter((r) => r.model === model && r.mode === mode);
      let votesCorrect = 0;
      let votesTotal = 0;
      let votesWrong = 0;
      let votesEscalated = 0;
      for (const ticker of run.tickers) {
        const rs = mine.filter((r) => r.ticker === ticker);
        const predicted: FactMap = Object.fromEntries(rs.map((r) => [r.factId, r.extraction?.value ?? null]));
        const goldMap: FactMap = Object.fromEntries(rs.filter((r) => r.hasGold).map((r) => [r.factId, r.gold]));
        const reference: FactMap = { ...predicted, ...goldMap }; // facts without gold can't disagree
        const p = evaluatePolicy(GOLD_POLICY, predicted).decisions;
        const ref = evaluatePolicy(GOLD_POLICY, reference).decisions;
        // A wrong fact is consequential if it feeds a vote that came out wrong. (Counting only facts
        // that flip a vote on their own misses votes broken by two missing facts at once.)
        const wrongItems = new Set(ref.filter((d, i) => d.vote !== p[i]?.vote).map((d) => d.item));
        const behindWrongVote = new Set(
          GOLD_POLICY.rules.filter((rule) => wrongItems.has(rule.item)).flatMap((rule) => factsInExpr(rule.when)),
        );
        for (const r of rs) r.consequential = r.hasGold ? !r.correct && behindWrongVote.has(r.factId) : null;
        if (rs.some((r) => r.hasGold)) {
          votesTotal += ref.length;
          votesCorrect += ref.filter((d, i) => d.vote === p[i]?.vote).length;
          votesWrong += ref.filter((d, i) => d.vote !== p[i]?.vote && p[i]?.vote !== "REVIEW").length;
          votesEscalated += ref.filter((d, i) => d.vote !== p[i]?.vote && p[i]?.vote === "REVIEW").length;
        }
      }
      summary.push({ ...summarize(model, mode, mine, votesCorrect, votesTotal), votesWrong, votesEscalated });
    }

  if (results.length) {
    await c.results.bulkWrite(
      results.map((r) => ({
        updateOne: {
          filter: { _id: r._id },
          update: { $set: { checks: r.checks, hasGold: r.hasGold, gold: r.gold, correct: r.correct, stage: r.stage, consequential: r.consequential } },
        },
      })),
    );
  }
  await c.runs.updateOne({ _id: runId }, { $set: { summary, gradedWith: gradeWith, gradedAt: now() } });
  return (await c.runs.findOne({ _id: runId }))!;
}

/** Citation checks, correctness and stage attribution for one stored answer (mutates r). */
function gradeOne(r: FactResult, gold: Map<string, GoldFact>, docChunks: Map<string, Chunk[]>, chunkById: Map<string, Chunk>) {
  const fact = FACT_BY_ID[r.factId];
  const g = gold.get(`${r.ticker}:${r.factId}`);
  const ex = r.extraction;
  const context = r.retrievedChunkIds.map((id) => chunkById.get(id)).filter((ch): ch is Chunk => Boolean(ch));
  const cited = ex?.chunkId && r.retrievedChunkIds.includes(ex.chunkId) ? chunkById.get(ex.chunkId) : undefined;
  r.checks = ex ? citationChecks(ex, cited, fact, g) : { quoteInChunk: null, valueInQuote: null, pageMatchesGold: null };
  r.hasGold = Boolean(g);
  r.gold = g ? g.value : null;
  r.correct = g ? (ex ? valuesMatch(ex.value, g.value, r.factId) : false) : null;
  const goldIsNull = !g || g.value === null;
  r.stage = g
    ? attribute({
        apiError: Boolean(r.error) && !r.malformed,
        malformed: Boolean(r.malformed),
        extraction: ex,
        correct: Boolean(r.correct),
        checks: r.checks,
        evidenceInDoc: goldIsNull || evidenceIn(docChunks.get(r.ticker) ?? [], g, fact),
        evidenceInContext: goldIsNull || evidenceIn(context, g, fact),
      })
    : null;
  r.consequential = null;
}

/** Chunk ids shift when the parser changes, so re-find the gold evidence by its quote. */
function resolveGoldChunk(g: GoldFact, byId: Map<string, Chunk>, doc: Chunk[]): Chunk | undefined {
  const direct = g.chunkId ? byId.get(g.chunkId) : undefined;
  if (!g.quote) return direct;
  if (direct && textContains(direct.text, g.quote)) return direct;
  const samePage = doc.filter((ch) => ch.page === g.page);
  return samePage.find((ch) => textContains(ch.text, g.quote!)) ?? doc.find((ch) => textContains(ch.text, g.quote!)) ?? direct;
}

function summarize(model: string, mode: Mode, rs: FactResult[], votesCorrect: number, votesTotal: number): ModelSummary {
  const graded = rs.filter((r) => r.hasGold);
  const correct = graded.filter((r) => r.correct).length;
  const answered = rs.filter((r) => r.extraction && r.extraction.value !== null);
  const byStage: Partial<Record<Stage, number>> = {};
  for (const r of graded) if (r.stage) byStage[r.stage] = (byStage[r.stage] ?? 0) + 1;
  return {
    model,
    mode,
    facts: rs.length,
    graded: graded.length,
    correct,
    accuracy: graded.length ? correct / graded.length : null,
    consequentialErrors: rs.filter((r) => r.consequential).length,
    votesCorrect,
    votesTotal,
    citationValid: answered.length
      ? answered.filter((r) => r.checks.quoteInChunk === true && r.checks.valueInQuote !== false).length / answered.length
      : 0,
    malformed: rs.filter((r) => r.malformed).length,
    byStage,
    costUsd: rs.reduce((s, r) => s + (r.costUsd ?? 0), 0),
    avgLatencyMs: rs.length ? rs.reduce((s, r) => s + r.latencyMs, 0) / rs.length : 0,
  };
}
