import { z } from "zod";
import { errorStatus, loadImprove } from "@/app/improve/data";
import { approveProposal } from "@/lib/improve/loop";

export const dynamic = "force-dynamic";

const Params = z.object({ id: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/, "Invalid proposal id") });

/**
 * POST /api/proposals/[id]/approve -> builds a config on top of the active one and starts a
 * (paid, ~$0.05) validation run in the background. Returns { configId, runId, ...payload }.
 */
export async function POST(_request: Request, ctx: RouteContext<"/api/proposals/[id]/approve">) {
  const parsed = Params.safeParse(await ctx.params);
  if (!parsed.success) return Response.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  try {
    const { configId, runId } = await approveProposal(parsed.data.id);
    return Response.json({ configId, runId, ...(await loadImprove()) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: errorStatus(message) });
  }
}
