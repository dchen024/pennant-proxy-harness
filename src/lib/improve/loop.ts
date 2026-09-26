import fs from "node:fs/promises";
import { z } from "zod";
import { MODEL_PROFILES } from "../config";
import { collections, getDb } from "../db";
import { FACTS, FACT_BY_ID } from "../facts";
import { systemPrompt } from "../harness/extract";
import { runToCompletion, startRun } from "../harness/run";
import { chatJSON } from "../openrouter";
import { assertWritable } from "../readonly";
import { FACT_IDS, type ConfigDoc, type FactId, type ProposalDoc, type ProposalKind, type ValidationReport } from "../types";

// The improvement loop: an agent proposes changes from graded failures, a human approves or
// rejects each one, and an approved change is validated by a fresh run against the run it came
// from. It is kept only if it fixes a case it targeted without losing accuracy or votes.

export const AGENT_MODEL = "anthropic/claude-opus-5.5";
export const VALIDATION_MODELS = MODEL_PROFILES.dev;
const now = () => new Date().toISOString();

/** The latest config whose change survived validation (or null for the base configuration). */
export async function activeConfig(): Promise<ConfigDoc | null> {
  const c = await collections();
  const kept = await c.proposals.find({ status: "kept", configId: { $exists: true } }).sort({ decidedAt: -1 }).limit(1).next();
  return kept?.configId ? c.configs.findOne({ _id: kept.configId }) : null;
}

const currentText = (cfg: ConfigDoc | null, kind: ProposalKind, target: string): string | null => {
  if (kind === "prompt_rule") return null;
  const fact = FACT_BY_ID[target as FactId];
  if (kind === "fact_definition") return cfg?.factDescriptions[target as FactId] ?? fact.description;
  return cfg?.factQueries[target as FactId] ?? fact.query;
};

const Proposals = z.object({
  proposals: z.array(
    z.object({
      kind: z.enum(["prompt_rule", "fact_definition", "retrieval_query"]),
      target: z.string(),
      after: z.string(),
      rationale: z.string(),
      fixes: z.array(z.string()),
      risk: z.string(),
    }),
  ),
});
const PROPOSALS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["proposals"],
  properties: {
    proposals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "target", "after", "rationale", "fixes", "risk"],
        properties: {
          kind: { type: "string", enum: ["prompt_rule", "fact_definition", "retrieval_query"] },
          target: { type: "string" },
          after: { type: "string" },
          rationale: { type: "string" },
          fixes: { type: "array", items: { type: "string" } },
          risk: { type: "string" },
        },
      },
    },
  },
};

const AGENT_SYSTEM = `You improve a harness that extracts facts from SEC proxy statements for a proxy-voting policy.
You receive graded failures (what each model answered vs. a human-verified answer key, the pipeline stage blamed,
an LLM judge's diagnosis, and notes), plus the current extraction prompt, fact definitions and search queries.

Propose at most 3 changes. Each is exactly one of:
- prompt_rule: one rule appended to the extraction system prompt (target "system"; "after" is the rule text).
- fact_definition: a clearer definition for one fact (target = fact id; "after" is the full new definition).
- retrieval_query: a better search query for one fact (target = fact id; "after" is the full new query).

Requirements:
- Each change must address specific failures listed; put their case ids in "fixes".
- It must generalize: never mention a specific company, person, number or page from a filing.
- It must not break answers that are currently right; say what could go wrong in "risk".
- Prefer the smallest change that fixes the root cause. Return only JSON.`;

/** Ask the agent for proposals based on a graded run. Stores them as pending. */
export async function proposeImprovements(sourceRunId: string): Promise<ProposalDoc[]> {
  const c = await collections();
  const run = await c.runs.findOne({ _id: sourceRunId });
  if (!run) throw new Error(`run ${sourceRunId} not found`);
  const cfg = await activeConfig();
  const failures = await c.results.find({ runId: sourceRunId, hasGold: true, correct: false }).toArray();
  const judgments = await (await getDb()).collection<{ _id: string; verdict: string; reason: string }>("judgments")
    .find({ _id: { $in: failures.map((f) => f._id) } }).toArray();
  const judged = new Map(judgments.map((j) => [j._id, j]));
  const casebook: { cases: { id: string; traps: string[]; note: string }[] } = JSON.parse(
    await fs.readFile("data/casebook.json", "utf8").catch(() => '{"cases":[]}'),
  );
  const notes = new Map(casebook.cases.map((k) => [k.id, k]));

  const byCase = new Map<string, typeof failures>();
  for (const f of failures) byCase.set(`${f.ticker}:${f.factId}`, [...(byCase.get(`${f.ticker}:${f.factId}`) ?? []), f]);
  const dossier = [...byCase.entries()].map(([id, rs]) => {
    const fact = FACT_BY_ID[rs[0].factId];
    const lines = rs.map((r) => {
      const j = judged.get(r._id);
      return `  - ${r.model} (${r.mode === "oracle" ? "given the correct passage" : "full pipeline"}): answered ${JSON.stringify(r.extraction?.value ?? null)}, stage=${r.stage}${j ? `, judge: ${j.verdict} — ${j.reason}` : ""}`;
    });
    const k = notes.get(id);
    return `CASE ${id} (${fact.label}); verified answer ${JSON.stringify(rs[0].gold)}${k ? `; trap: ${k.traps.join(",")}; note: ${k.note}` : ""}\n${lines.join("\n")}`;
  });
  const involved = [...new Set(failures.map((f) => f.factId))];
  const defs = involved
    .map((id) => `- ${id}\n  definition: ${currentText(cfg, "fact_definition", id)}\n  search query: ${currentText(cfg, "retrieval_query", id)}`)
    .join("\n");
  const user = `Current extraction system prompt:\n"""\n${systemPrompt(cfg ? { systemAppend: cfg.systemAppend } : undefined)}\n"""\n\nFacts involved:\n${defs}\n\nGraded failures from run ${sourceRunId}:\n${dossier.join("\n\n")}`;

  const res = await chatJSON({ model: AGENT_MODEL, system: AGENT_SYSTEM, user, schema: Proposals, jsonSchema: PROPOSALS_SCHEMA, schemaName: "proposals", maxTokens: 6000 });
  if (!res.data) throw new Error(`agent failed: ${res.error}`);
  const stamp = now().replace(/[-:T.Z]/g, "").slice(0, 14);
  const docs: ProposalDoc[] = res.data.proposals
    .filter((p) => (p.kind === "prompt_rule" ? true : (FACT_IDS as readonly string[]).includes(p.target)))
    .map((p, i) => ({
      _id: `prop_${stamp}_${i + 1}`,
      kind: p.kind,
      target: p.kind === "prompt_rule" ? "system" : p.target,
      before: currentText(cfg, p.kind, p.target),
      after: p.after,
      rationale: p.rationale,
      fixes: p.fixes,
      risk: p.risk,
      status: "pending",
      sourceRunId,
      agentModel: AGENT_MODEL,
      createdAt: now(),
    }));
  if (docs.length) await c.proposals.insertMany(docs);
  return docs;
}

/** Human approval: builds a new config on top of the active one and starts a validation run. */
export async function approveProposal(id: string, opts: { wait?: boolean } = {}) {
  assertWritable("approving a proposal");
  const c = await collections();
  const p = await c.proposals.findOne({ _id: id });
  if (!p) throw new Error(`proposal ${id} not found`);
  if (p.status !== "pending") throw new Error(`proposal ${id} is already ${p.status}`);
  const parent = await activeConfig();
  const n = (await c.configs.countDocuments()) + 1;
  const cfg: ConfigDoc = {
    _id: `cfg_${n}`,
    parent: parent?._id ?? null,
    systemAppend: [...(parent?.systemAppend ?? []), ...(p.kind === "prompt_rule" ? [p.after] : [])],
    factDescriptions: { ...(parent?.factDescriptions ?? {}), ...(p.kind === "fact_definition" ? { [p.target]: p.after } : {}) },
    factQueries: { ...(parent?.factQueries ?? {}), ...(p.kind === "retrieval_query" ? { [p.target]: p.after } : {}) },
    fromProposals: [...(parent?.fromProposals ?? []), p._id],
    createdAt: now(),
  };
  await c.configs.insertOne(cfg);
  const source = await c.runs.findOne({ _id: p.sourceRunId });
  // Compare against the configuration this change is built on, so each report measures one change.
  const parentProposal = parent ? await c.proposals.findOne({ configId: parent._id }) : null;
  const baselineRunId = parentProposal?.validationRunId ?? p.sourceRunId;
  const runOpts = {
    models: VALIDATION_MODELS,
    modes: ["e2e" as const],
    tickers: source?.tickers,
    parserVersion: source?.config.parserVersion,
    retrieval: (source?.config.retrieval as "vector" | "hybrid" | undefined) ?? "hybrid",
    configId: cfg._id,
    label: `validate ${p._id}: ${p.kind} ${p.target}`,
  };
  const runId = opts.wait ? (await runToCompletion(runOpts))._id : await startRun(runOpts);
  await c.proposals.updateOne({ _id: id }, { $set: { status: "approved", configId: cfg._id, validationRunId: runId, baselineRunId, decidedAt: now() } });
  return { configId: cfg._id, runId };
}

/**
 * Human revert of a kept change, e.g. when a later run shows harm validation missed. Only the newest
 * kept change can be reverted, so the config chain stays consistent: the active config then falls
 * back to the previous kept one.
 */
export async function revertProposal(id: string, note: string) {
  assertWritable("reverting a proposal");
  const c = await collections();
  const p = await c.proposals.findOne({ _id: id });
  if (!p) throw new Error(`proposal ${id} not found`);
  if (p.status !== "kept") throw new Error(`proposal ${id} is ${p.status}; only kept changes can be reverted`);
  const active = await activeConfig();
  if (active?._id !== p.configId) throw new Error(`revert the newer kept change first (active config is ${active?._id})`);
  await c.proposals.updateOne({ _id: id }, { $set: { status: "reverted", revertNote: note, decidedAt: now() } });
  return activeConfig();
}

export async function rejectProposal(id: string) {
  assertWritable("rejecting a proposal");
  const c = await collections();
  await c.proposals.updateOne({ _id: id, status: "pending" }, { $set: { status: "rejected", decidedAt: now() } });
}

/** Once the validation run is done, compare it with the source run and keep or revert the change. */
export async function refreshValidation(id: string, opts: { force?: boolean } = {}): Promise<ProposalDoc | null> {
  const c = await collections();
  const p = await c.proposals.findOne({ _id: id });
  if (!p || !p.validationRunId) return p;
  if (p.status !== "approved" && !(opts.force && (p.status === "kept" || p.status === "reverted"))) return p;
  const run = await c.runs.findOne({ _id: p.validationRunId });
  if (!run || run.status !== "done") return p;

  const after = await c.results.find({ runId: run._id, hasGold: true }).toArray();
  const baselineRunId = p.baselineRunId ?? p.sourceRunId;
  const before = await c.results.find({ runId: baselineRunId, mode: "e2e", model: { $in: run.models }, hasGold: true }).toArray();
  const key = (r: { model: string; ticker: string; factId: string }) => `${r.model} ${r.ticker}:${r.factId}`;
  const beforeMap = new Map(before.map((r) => [key(r), r.correct]));
  const gained = after.filter((r) => r.correct && beforeMap.get(key(r)) === false).map(key);
  const lost = after.filter((r) => !r.correct && beforeMap.get(key(r)) === true).map(key);
  const source = await c.runs.findOne({ _id: baselineRunId });
  const wrongVotesAdded = run.models.some((model) => {
    const s0 = source?.summary?.find((s) => s.model === model && s.mode === "e2e");
    const s1 = run.summary?.find((s) => s.model === model && s.mode === "e2e");
    return (s1?.votesWrong ?? 0) > (s0?.votesWrong ?? 0);
  });
  const perModel = run.models.map((model) => {
    const s0 = source?.summary?.find((s) => s.model === model && s.mode === "e2e");
    const s1 = run.summary?.find((s) => s.model === model && s.mode === "e2e");
    return {
      model,
      before: s0?.correct ?? 0,
      after: s1?.correct ?? 0,
      graded: s1?.graded ?? 0,
      votesBefore: s0?.votesCorrect ?? 0,
      votesAfter: s1?.votesCorrect ?? 0,
      votesTotal: s1?.votesTotal ?? 0,
    };
  });
  // A fact-level change can only affect its own fact; flips elsewhere are run-to-run noise
  // (models are not fully deterministic even at temperature 0) and don't count toward the verdict.
  const affected = (k: string) => p.kind === "prompt_rule" || k.endsWith(`:${p.target}`);
  const targeted = gained.filter((g) => p.fixes.some((f) => g.endsWith(f)));
  const net = gained.filter(affected).length - lost.filter(affected).length;
  const noise = [...gained, ...lost].filter((k) => !affected(k));
  const touchedLost = lost.filter(affected);
  const votesOk = perModel.every((m) => m.votesAfter >= m.votesBefore);
  // Do no harm: keep only if it fixes a targeted case, breaks nothing it touches, and loses no vote.
  const keep = targeted.length > 0 && touchedLost.length === 0 && votesOk && !wrongVotesAdded;
  const report: ValidationReport = {
    baselineRunId,
    validationRunId: run._id,
    perModel,
    gained: gained.filter(affected),
    lost: lost.filter(affected),
    noise,
    verdict: keep ? "keep" : "revert",
    reason: keep
      ? `Fixed ${targeted.length} targeted case(s); net ${net >= 0 ? "+" : ""}${net} on the facts this change touches.${noise.length ? ` ${noise.length} flip(s) on untouched facts are run-to-run noise.` : ""}`
      : wrongVotesAdded
        ? "Created a wrong vote (a flipped FOR/AGAINST), which is never acceptable."
        : targeted.length === 0
        ? "Didn't fix any case it targeted."
        : touchedLost.length > 0
          ? `Fixed a targeted case but broke ${touchedLost.length} answer(s) on the facts it touches.`
          : "Fixed a targeted case but lost a correct vote.",
  };
  await c.proposals.updateOne({ _id: id }, { $set: { report, status: keep ? "kept" : "reverted", decidedAt: now() } });
  return c.proposals.findOne({ _id: id });
}

export async function listProposals(): Promise<ProposalDoc[]> {
  const c = await collections();
  const all = await c.proposals.find({}).sort({ createdAt: -1 }).toArray();
  for (const p of all.filter((x) => x.status === "approved")) await refreshValidation(p._id);
  return c.proposals.find({}).sort({ createdAt: -1 }).toArray();
}

export const FACT_LABELS = Object.fromEntries(FACTS.map((f) => [f.id, f.label]));
