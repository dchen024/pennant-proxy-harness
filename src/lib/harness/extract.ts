import { traceable } from "langsmith/traceable";
import { z } from "zod";
import { FACT_BY_ID } from "../facts";
import { chatJSON, type JsonCallResult } from "../openrouter";
import type { Chunk, Extraction, FactDef, FactId } from "../types";

export const EXTRACTION_SYSTEM = `You extract facts from SEC proxy statements (DEF 14A) for an institutional investor's proxy-voting team.

Rules:
- Use ONLY the excerpts provided. Never use outside knowledge.
- Cite exactly one excerpt by its id and copy a verbatim quote from it: the shortest span that contains the answer (usually one table row or one sentence). Copy characters exactly; table cells are separated by " | ".
- Numbers: return a plain number in full units, e.g. 29815000 for "$29,815" in a table stated "in thousands", 12500000 for "$12.5 million". Counts are integers. A dash (—) in a fee table means 0.
- Period: "most recent fiscal year" is the latest year column; read the column headers before choosing a value.
- Person: the CEO is the principal executive officer; make sure the row you read belongs to them.
- Booleans: true or false.
- Absence is an answer. Some facts are false or 0 when a feature doesn't exist (no lead independent director, no sunset provision, no "All Other Fees" row). If the excerpts cover the topic (the board leadership structure, the share classes, the complete fee table) and the feature is absent, answer false or 0 and cite the passage that shows it, such as the leadership description, the share-class description, or the fee table's total row.
- Only if the excerpts don't cover the topic at all, return value null, chunk_id null and quote null.
- fiscal_year: the fiscal year the value refers to, or null if the fact has no period.
Return only JSON.`;

const toNumber = (v: unknown) =>
  typeof v === "string" && /^[\s$()\d,.-]+$/.test(v) && /\d/.test(v) ? Number(v.replace(/[$,\s()]/g, "")) : v;
const toBoolean = (v: unknown) =>
  typeof v === "string" && /^(true|false|yes|no)$/i.test(v.trim()) ? /^(true|yes)$/i.test(v.trim()) : v;

function schemaFor(fact: FactDef) {
  const value =
    fact.type === "number"
      ? z.preprocess(toNumber, z.number().nullable())
      : z.preprocess(toBoolean, z.boolean().nullable());
  return z.object({
    value,
    chunk_id: z.string().nullable(),
    quote: z.string().nullable(),
    fiscal_year: z.preprocess(toNumber, z.number().int().nullable()),
  });
}

function jsonSchemaFor(fact: FactDef) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      value: { type: [fact.type, "null"] },
      chunk_id: { type: ["string", "null"] },
      quote: { type: ["string", "null"] },
      fiscal_year: { type: ["integer", "null"] },
    },
    required: ["value", "chunk_id", "quote", "fiscal_year"],
  };
}

export function buildUserPrompt(company: string, ticker: string, fact: FactDef, chunks: Chunk[]) {
  const excerpts = chunks
    .map((c) => {
      const before = c.context ? `<preceding_text>\n${c.context}\n</preceding_text>\n` : "";
      return `<excerpt id="${c._id}" page="${c.page}">\n${before}${c.text}\n</excerpt>`;
    })
    .join("\n\n");
  const note = chunks.some((c) => c.context)
    ? "\n\n<preceding_text> shows what comes just before an excerpt (such as its section or table title). Use it to understand the excerpt, but quote only from the excerpt body."
    : "";
  return `Company: ${company} (${ticker})
Fact: ${fact.label}
Definition: ${fact.description}
Answer type: ${fact.type}${fact.unit ? ` (${fact.unit})` : ""}

Excerpts:
${excerpts}${note}`;
}

export type ExtractionCall = JsonCallResult<Extraction>;

export interface ExtractionOverrides {
  /** Extra rules appended to the system prompt (from approved proposals). */
  systemAppend?: string[];
  /** A clarified fact definition (from an approved proposal). */
  description?: string;
}

export function systemPrompt(overrides?: ExtractionOverrides) {
  const extra = overrides?.systemAppend?.length ? `\n\nAdditional rules:\n${overrides.systemAppend.map((r) => `- ${r}`).join("\n")}` : "";
  return EXTRACTION_SYSTEM + extra;
}

export const extractFact = traceable(
  async (args: { model: string; company: string; ticker: string; factId: FactId; chunks: Chunk[]; overrides?: ExtractionOverrides }): Promise<ExtractionCall> => {
    const base = FACT_BY_ID[args.factId];
    const fact = args.overrides?.description ? { ...base, description: args.overrides.description } : base;
    const res = await chatJSON({
      model: args.model,
      system: systemPrompt(args.overrides),
      user: buildUserPrompt(args.company, args.ticker, fact, args.chunks),
      schema: schemaFor(fact),
      jsonSchema: jsonSchemaFor(fact),
      schemaName: "fact_extraction",
    });
    const data: Extraction | null = res.data
      ? { value: res.data.value, chunkId: res.data.chunk_id, quote: res.data.quote, fiscalYear: res.data.fiscal_year }
      : null;
    return { ...res, data };
  },
  { name: "extract_fact", run_type: "chain" },
);
