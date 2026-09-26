import type { NextRequest } from "next/server";
import { z } from "zod";
import { getChunks, getPageChunks } from "@/lib/queries";

export const dynamic = "force-dynamic";

const PageQuery = z.object({
  ticker: z.string().min(1).max(12),
  page: z.coerce.number().int().positive(),
  parser: z
    .string()
    .regex(/^v\d+$/, "parser must look like v2 or v3")
    .default("v2"),
});

/**
 * GET /api/chunks?ids=a,b,c                   -> chunks by id
 * GET /api/chunks?ticker=X&page=N&parser=v2    -> every chunk on one page, in reading order
 * Lines + bboxes only, never embeddings.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  if (params.has("ticker") || params.has("page")) {
    const parsed = PageQuery.safeParse({
      ticker: params.get("ticker") ?? undefined,
      page: params.get("page") ?? undefined,
      parser: params.get("parser") ?? undefined,
    });
    if (!parsed.success) {
      return Response.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
    }
    const { ticker, page, parser } = parsed.data;
    const chunks = await getPageChunks(ticker, page, parser);
    return Response.json({ chunks });
  }

  const ids = params
    .getAll("ids")
    .flatMap((v) => v.split(","))
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 200);
  const chunks = await getChunks(ids);
  return Response.json({ chunks });
}
