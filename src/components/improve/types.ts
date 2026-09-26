import type { ConfigDoc, ProposalDoc, RunDoc } from "@/lib/types";

/** Just enough of a run to label and track it on the Improve page. */
export interface RunBrief {
  _id: string;
  label?: string;
  status: RunDoc["status"];
  progress: RunDoc["progress"];
  startedAt: string;
  finishedAt?: string;
}

/** What GET /api/proposals (and the approve/reject routes) return. */
export interface ProposalsPayload {
  proposals: ProposalDoc[];
  activeConfig: ConfigDoc | null;
  runs: Record<string, RunBrief>;
}

/** GET /api/proposals/[id]/preview: where the evidence ranks for the old vs new search query. */
export interface RetrievalPreview {
  k: number;
  parserVersion: string;
  cases: {
    caseId: string;
    evidenceChunkId: string | null;
    evidencePage: number | null;
    before: { rank: number | null; pages: number[] };
    after: { rank: number | null; pages: number[] };
  }[];
}
