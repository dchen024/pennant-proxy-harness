import { getResults, getRun } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: RouteContext<"/api/runs/[id]">) {
  const { id: runId } = await ctx.params;
  const [run, results] = await Promise.all([getRun(runId), getResults(runId)]);
  if (!run) return Response.json({ error: `Run ${runId} not found` }, { status: 404 });
  return Response.json({ run, results });
}
