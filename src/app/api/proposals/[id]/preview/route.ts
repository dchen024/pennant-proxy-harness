import { z } from "zod";
import type { RetrievalPreview } from "@/components/improve/types";
import { collections } from "@/lib/db";
import { keywordSearch } from "@/lib/harness/retrieve";
import { getGoldById } from "@/lib/queries";

export const dynamic = "force-dynamic";

const Params = z.object({ id: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/, "Invalid proposal id") });
const K = 8;

/** v2 and v3 chunks share boundaries: "JPM:v3:p93:2" and "JPM:p93:2" are the same passage. */
const canonical = (id: string) => id.replace(/:v\d+:/, ":");
const pageOf = (id: string) => Number(id.match(/:p(\d+):/)?.[1] ?? 0) || null;

/**
 * GET /api/proposals/[id]/preview -> for a retrieval_query proposal, the rank of each targeted case's
 * verified evidence chunk in keyword (BM25) search with the old and the new query. Free and read-only:
 * no embedding call, no retrieval cache writes.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/proposals/[id]/preview">) {
  const parsed = Params.safeParse(await ctx.params);
  if (!parsed.success) return Response.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  try {
    const c = await collections();
    const p = await c.proposals.findOne({ _id: parsed.data.id });
    if (!p) return Response.json({ error: `proposal ${parsed.data.id} not found` }, { status: 404 });
    if (p.kind !== "retrieval_query" || p.before === null) {
      return Response.json({ error: "Only search-query proposals have a retrieval preview" }, { status: 400 });
    }
    const run = await c.runs.findOne({ _id: p.sourceRunId }, { projection: { config: 1 } });
    const parserVersion = run?.config.parserVersion ?? "v2";
    const cases = await Promise.all(
      p.fixes.map(async (caseId) => {
        const ticker = caseId.slice(0, caseId.indexOf(":"));
        const gold = await getGoldById(caseId);
        const evidence = gold?.chunkId ? canonical(gold.chunkId) : null;
        const [before, after] = await Promise.all([
          keywordSearch(ticker, p.before!, K, parserVersion),
          keywordSearch(ticker, p.after, K, parserVersion),
        ]);
        const summarize = (hits: { _id: string }[]) => {
          const i = evidence ? hits.findIndex((h) => canonical(h._id) === evidence) : -1;
          return { rank: i >= 0 ? i + 1 : null, pages: hits.map((h) => pageOf(h._id) ?? 0) };
        };
        return {
          caseId,
          evidenceChunkId: gold?.chunkId ?? null,
          evidencePage: gold?.page ?? (evidence ? pageOf(evidence) : null),
          before: summarize(before),
          after: summarize(after),
        };
      }),
    );
    const body: RetrievalPreview = { k: K, parserVersion, cases };
    return Response.json(body);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
