import type { NextRequest } from "next/server";
import { z } from "zod";
import { searchChunks } from "@/lib/queries";

export const dynamic = "force-dynamic";

const SearchQuery = z.object({
  ticker: z.string().min(1).max(12),
  q: z.string().trim().min(2, "Type at least 2 characters").max(200),
  parser: z
    .string()
    .regex(/^v\d+$/, "parser must look like v2 or v3")
    .default("v2"),
  limit: z.coerce.number().int().min(1).max(15).default(15),
});

/** GET /api/search?ticker=X&q=...&parser=v2 -> up to 15 matching passages in one filing (no embeddings). */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const parsed = SearchQuery.safeParse({
    ticker: params.get("ticker") ?? undefined,
    q: params.get("q") ?? undefined,
    parser: params.get("parser") ?? undefined,
    limit: params.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  const { ticker, q, parser, limit } = parsed.data;
  const { hits, total } = await searchChunks(ticker, q, parser, limit);
  return Response.json({ hits, total });
}
