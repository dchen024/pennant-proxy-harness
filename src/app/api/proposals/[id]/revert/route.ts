import { z } from "zod";
import { revertProposal } from "@/lib/improve/loop";
import { READ_ONLY, readOnlyResponse } from "@/lib/readonly";

const Body = z.object({ note: z.string().trim().min(1).max(2000) });

/** Human revert of the newest kept change (the active config falls back to the previous one). */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (READ_ONLY) return readOnlyResponse();
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "A note explaining the revert is required." }, { status: 400 });
  try {
    const active = await revertProposal(id, parsed.data.note);
    return Response.json({ ok: true, activeConfig: active?._id ?? null });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
