import { z } from "zod";
import { FACT_BY_ID } from "@/lib/facts";
import { normalize } from "@/lib/highlight";
import { getChunks, getDbStatus, getGoldById, listGold, updateGold } from "@/lib/queries";
import type { FactValue } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const gold = await listGold();
  return Response.json({ gold });
}

const GoldUpdateBody = z.object({
  id: z.string().min(1),
  /** Omit to leave the value alone (e.g. when only the citation changes). */
  value: z.union([z.number(), z.boolean(), z.null()]).optional(),
  /** Omit to leave the status alone. */
  status: z.enum(["verified", "proposed", "disputed"]).optional(),
  chunkId: z.string().nullable().optional(),
  quote: z.string().max(4000).nullable().optional(),
  page: z.number().int().positive().nullable().optional(),
  /** Who chose the evidence: a drafting model, a curator, or the human reviewer. */
  evidenceBy: z.enum(["draft", "curated", "reviewer"]).optional(),
  note: z.string().max(500).optional(),
});

/** Chunk ids look like `${ticker}:p${page}:${index}` (v3: `${ticker}:v3:p${page}:${index}`). */
function pageFromChunkId(chunkId: string | null | undefined): number | null {
  const m = chunkId?.match(/:p(\d+):/);
  return m ? Number(m[1]) : null;
}

const bad = (error: string, status = 400) => Response.json({ error }, { status });

/** POST /api/gold -> verify, re-open, or re-cite one answer-key fact. */
export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return bad("Body must be JSON");
  }
  const parsed = GoldUpdateBody.safeParse(json);
  if (!parsed.success) return bad(parsed.error.issues.map((i) => i.message).join("; "));
  const body = parsed.data;

  const status = await getDbStatus();
  if (!status.ok) return bad(status.message, 503);

  const existing = await getGoldById(body.id);
  if (!existing) return bad(`Gold fact ${body.id} not found`, 404);

  const update: Parameters<typeof updateGold>[1] = {};

  if (body.value !== undefined) {
    const def = FACT_BY_ID[existing.factId];
    let value: FactValue = body.value;
    if (value !== null && def) {
      if (def.type === "boolean" && typeof value !== "boolean") return bad(`${def.label} is a yes/no fact`);
      if (def.type === "number" && typeof value !== "number") return bad(`${def.label} must be a number`);
      if (typeof value === "number" && !Number.isFinite(value)) value = null;
    }
    update.value = value;
  }
  if (body.status !== undefined) update.status = body.status;

  if (body.evidenceBy === "reviewer") {
    // A human-chosen citation must be verbatim text of a real chunk of this filing.
    if (!body.chunkId || !body.quote?.trim()) return bad("A reviewer citation needs a chunkId and a quote");
    const [chunk] = await getChunks([body.chunkId]);
    if (!chunk) return bad(`Chunk ${body.chunkId} does not exist`);
    if (chunk.ticker !== existing.ticker) return bad(`Chunk ${body.chunkId} belongs to ${chunk.ticker}, not ${existing.ticker}`);
    const chunkText = normalize(chunk.lines.map((l) => l.text).join(" "));
    if (!chunkText.includes(normalize(body.quote))) return bad("The quote is not verbatim text of that chunk");
    update.chunkId = chunk._id;
    update.quote = body.quote;
    update.page = chunk.page;
  } else {
    if (body.chunkId !== undefined) {
      update.chunkId = body.chunkId;
      update.page = body.page ?? pageFromChunkId(body.chunkId);
    } else if (body.page !== undefined) {
      update.page = body.page;
    }
    if (body.quote !== undefined) update.quote = body.quote;
  }
  if (body.evidenceBy !== undefined) update.evidenceBy = body.evidenceBy;
  if (body.note !== undefined) update.note = body.note;

  if (Object.keys(update).length === 0) return bad("Nothing to update");

  try {
    const gold = await updateGold(existing._id, update);
    return Response.json({ gold });
  } catch (err) {
    return bad(err instanceof Error ? err.message : String(err), 500);
  }
}
