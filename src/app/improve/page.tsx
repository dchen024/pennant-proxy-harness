import type { Metadata } from "next";
import { DbBanner, EmptyState } from "@/components/empty-state";
import { ImproveView } from "@/components/improve/improve-view";
import type { ProposalsPayload } from "@/components/improve/types";
import { getDbStatus } from "@/lib/queries";
import { loadImprove } from "./data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Improve · Proxy Harness" };

export default async function ImprovePage() {
  const status = await getDbStatus();
  if (!status.ok) {
    return (
      <div className="mx-auto w-full max-w-[1200px] space-y-5 px-5 py-6">
        <DbBanner status={status} />
        <EmptyState title="Proposals live in MongoDB" />
      </div>
    );
  }
  let payload: ProposalsPayload | null = null;
  let error: string | null = null;
  try {
    payload = await loadImprove();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  if (!payload) {
    return (
      <div className="mx-auto w-full max-w-[1200px] px-5 py-6">
        <EmptyState title="Could not load proposals">{error}</EmptyState>
      </div>
    );
  }
  return <ImproveView initial={payload} />;
}
