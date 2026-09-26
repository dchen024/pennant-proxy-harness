import { z } from "zod";
import { errorStatus, loadImprove } from "@/app/improve/data";
import { collections } from "@/lib/db";
import { rejectProposal } from "@/lib/improve/loop";

export const dynamic = "force-dynamic";

const Params = z.object({ id: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/, "Invalid proposal id") });

/** POST /api/proposals/[id]/reject -> marks a pending proposal rejected. Returns the fresh payload. */
export async function POST(_request: Request, ctx: RouteContext<"/api/proposals/[id]/reject">) {
  const parsed = Params.safeParse(await ctx.params);
  if (!parsed.success) return Response.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  const { id } = parsed.data;
  try {
    // rejectProposal() silently ignores non-pending proposals; say so explicitly instead.
    const c = await collections();
    const p = await c.proposals.findOne({ _id: id }, { projection: { status: 1 } });
    if (!p) return Response.json({ error: `proposal ${id} not found` }, { status: 404 });
    if (p.status !== "pending") return Response.json({ error: `proposal ${id} is already ${p.status}` }, { status: 409 });
    await rejectProposal(id);
    return Response.json(await loadImprove());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: errorStatus(message) });
  }
}
