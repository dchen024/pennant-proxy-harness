import "./_env";
import { z } from "zod";
import { GOLD_DRAFT_MODELS } from "@/lib/config";
import { closeDb, collections } from "@/lib/db";
import { FACTS } from "@/lib/facts";
import { textContains } from "@/lib/harness/checks";
import { EXTRACTION_SYSTEM } from "@/lib/harness/extract";
import { retrieve } from "@/lib/harness/retrieve";
import { chatJSON } from "@/lib/openrouter";
import { valuesMatch } from "@/lib/policy/evaluate";
import { FACT_IDS, type Chunk, type FactId, type GoldFact, type GoldProposal } from "@/lib/types";

// Drafts the answer key with two strong models that are NOT in the comparison.
// Agreements become "proposed", disagreements "disputed"; a human verifies both in /review.
// Verified answers are never overwritten. Usage: pnpm gold:draft [--tickers AAPL]

// Keyword net so the answer key isn't capped by vector retrieval quality.
const KEYWORDS: Record<FactId, RegExp> = {
  "board.nominee_count": /director nominees|nominees for (election|director)/i,
  "board.independent_nominee_count": /independen(t|ce)/i,
  "board.ceo_is_chair": /board leadership|chair(man|woman|person)? of the board/i,
  "board.has_lead_independent_director": /lead independent director/i,
  "governance.unequal_voting_rights": /class b|votes? per share|voting power/i,
  "governance.unequal_voting_sunset": /sunset/i,
  "pay.ceo_total_comp_current": /summary compensation table|\bSCT\b|principal position/i,
  "pay.ceo_total_comp_prior": /summary compensation table|\bSCT\b|principal position/i,
  "pay.company_tsr_current": /pay versus performance|initial fixed \$100|\$100 investment|\bTSR\d?\b/i,
  "pay.peer_tsr_current": /pay versus performance|initial fixed \$100|\$100 investment|\bTSR\d?\b/i,
  "audit.audit_fees_current": /audit fees/i,
  "audit.audit_related_fees_current": /audit-related fees/i,
  "audit.tax_fees_current": /tax fees/i,
  "audit.all_other_fees_current": /all other fees/i,
};

const coerce = (v: unknown) => {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (/^(true|false|yes|no)$/i.test(s)) return /^(true|yes)$/i.test(s);
  if (/\d/.test(s) && /^[\s$()\d,.-]+$/.test(s)) return Number(s.replace(/[$,\s()]/g, ""));
  return v;
};

const DraftSchema = z.object({
  facts: z.array(
    z.object({
      fact_id: z.enum(FACT_IDS),
      value: z.preprocess(coerce, z.union([z.number(), z.boolean()]).nullable()),
      chunk_id: z.string().nullable(),
      quote: z.string().nullable(),
      fiscal_year: z.preprocess(coerce, z.number().int().nullable()),
    }),
  ),
});

const DRAFT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          fact_id: { type: "string", enum: [...FACT_IDS] },
          value: { type: ["number", "boolean", "null"] },
          chunk_id: { type: ["string", "null"] },
          quote: { type: ["string", "null"] },
          fiscal_year: { type: ["integer", "null"] },
        },
        required: ["fact_id", "value", "chunk_id", "quote", "fiscal_year"],
      },
    },
  },
  required: ["facts"],
};

async function contextFor(ticker: string, all: Chunk[]): Promise<Chunk[]> {
  const picked = new Map<string, Chunk>();
  for (const f of FACTS) {
    for (const ch of await retrieve(ticker, f.id, 8)) picked.set(ch._id, ch);
    all
      .filter((ch) => KEYWORDS[f.id].test(ch.text))
      .sort((a, b) => Number(b.kind === "table") - Number(a.kind === "table"))
      .slice(0, 4)
      .forEach((ch) => {
        picked.set(ch._id, ch);
        // headings often land in the chunk just before their table: take the next chunk too
        const [, page, idx] = ch._id.match(/:p(\d+):(\d+)$/)!;
        const next = all.find((x) => x._id === `${ticker}:p${page}:${Number(idx) + 1}`);
        if (next) picked.set(next._id, next);
      });
  }
  return [...picked.values()].sort((a, b) => a.page - b.page || a._id.localeCompare(b._id));
}

async function main() {
  const arg = process.argv.indexOf("--tickers");
  const c = await collections();
  const filings = await c.filings.find(arg > -1 ? { _id: { $in: process.argv[arg + 1].split(",") } } : {}).toArray();
  let totalCost = 0;

  for (const filing of filings) {
    const all = await c.chunks.find({ ticker: filing._id }, { projection: { embedding: 0 } }).toArray();
    const byId = new Map(all.map((ch) => [ch._id, ch]));
    const context = await contextFor(filing._id, all);
    const factList = FACTS.map((f) => `- ${f.id} (${f.type}${f.unit ? `, ${f.unit}` : ""}): ${f.description}`).join("\n");
    const excerpts = context.map((ch) => `<excerpt id="${ch._id}" page="${ch.page}">\n${ch.text}\n</excerpt>`).join("\n\n");
    const user = `Company: ${filing.company} (${filing._id})\n\nAnswer every one of these facts (one entry per fact_id):\n${factList}\n\nExcerpts:\n${excerpts}`;

    const drafts = await Promise.all(
      GOLD_DRAFT_MODELS.map(async (model) => {
        const res = await chatJSON({ model, system: EXTRACTION_SYSTEM, user, schema: DraftSchema, jsonSchema: DRAFT_JSON_SCHEMA, schemaName: "gold_draft", maxTokens: 8000 });
        totalCost += res.costUsd ?? 0;
        if (!res.data) console.warn(`  ${model} failed on ${filing._id}: ${res.error}`);
        return { model, facts: new Map((res.data?.facts ?? []).map((f) => [f.fact_id, f])) };
      }),
    );

    let agreed = 0;
    for (const f of FACTS) {
      const proposals: GoldProposal[] = drafts
        .filter((d) => d.facts.has(f.id))
        .map((d) => {
          const p = d.facts.get(f.id)!;
          return { model: d.model, value: p.value, chunkId: p.chunk_id, quote: p.quote };
        });
      const agree = proposals.length === GOLD_DRAFT_MODELS.length && proposals.every((p) => valuesMatch(p.value, proposals[0].value, f.id));
      const supported = (p: GoldProposal) => Boolean(p.chunkId && p.quote && byId.has(p.chunkId) && textContains(byId.get(p.chunkId)!.text, p.quote));
      const best = proposals.find(supported) ?? proposals[0];
      const chunk = best?.chunkId ? byId.get(best.chunkId) : undefined;
      const id = `${filing._id}:${f.id}`;
      const existing = await c.gold.findOne({ _id: id });
      if (existing?.status === "verified") continue;
      const doc: GoldFact = {
        _id: id,
        ticker: filing._id,
        factId: f.id,
        value: best?.value ?? null,
        page: chunk?.page ?? null,
        quote: best?.quote ?? null,
        chunkId: chunk ? chunk._id : null,
        status: agree ? "proposed" : "disputed",
        proposals,
        updatedAt: new Date().toISOString(),
      };
      await c.gold.replaceOne({ _id: id }, doc, { upsert: true });
      if (agree) agreed++;
    }
    console.log(`${filing._id}: ${context.length} excerpts, ${agreed}/${FACTS.length} facts agreed`);
  }
  console.log(`drafting cost: $${totalCost.toFixed(4)}`);
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
