import type { NextRequest } from "next/server";
import { getResult } from "@/lib/queries";

export const dynamic = "force-dynamic";

/** GET /api/results?id=<resultId> -> the full FactResult, including raw model output. */
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "Missing ?id" }, { status: 400 });
  const result = await getResult(id);
  if (!result) return Response.json({ error: "Result not found" }, { status: 404 });
  return Response.json({ result });
}
