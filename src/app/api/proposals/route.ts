import { errorStatus, loadImprove } from "@/app/improve/data";

export const dynamic = "force-dynamic";

/** GET /api/proposals -> { proposals (newest first), activeConfig, runs }. */
export async function GET() {
  try {
    return Response.json(await loadImprove());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: errorStatus(message) });
  }
}
