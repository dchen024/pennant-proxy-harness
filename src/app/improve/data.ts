import "server-only";
import type { ProposalsPayload, RunBrief } from "@/components/improve/types";
import { activeConfig, listProposals } from "@/lib/improve/loop";
import { getRun } from "@/lib/queries";

/**
 * Proposals (newest first), the active config and brief info on every run they reference.
 * listProposals() also settles approved proposals whose validation run has finished.
 */
export async function loadImprove(): Promise<ProposalsPayload> {
  const proposals = await listProposals();
  const cfg = await activeConfig(); // after the refresh, so a just-kept change is included
  const ids = [
    ...new Set(
      proposals
        .flatMap((p) => [p.sourceRunId, p.validationRunId, p.baselineRunId, p.report?.baselineRunId])
        .filter((x): x is string => !!x),
    ),
  ];
  const runs: Record<string, RunBrief> = {};
  for (const run of await Promise.all(ids.map((id) => getRun(id)))) {
    if (!run) continue;
    runs[run._id] = {
      _id: run._id,
      label: run.label,
      status: run.status,
      progress: run.progress,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
  }
  return { proposals, activeConfig: cfg, runs };
}

/** Maps loop.ts errors to HTTP statuses. */
export function errorStatus(message: string): number {
  if (/not found/i.test(message)) return 404;
  if (/already|not pending/i.test(message)) return 409;
  if (/MONGODB_URI|connect|timed out/i.test(message)) return 503;
  return 500;
}
