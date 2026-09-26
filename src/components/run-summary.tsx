import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { ModeBadge, ModeInfo } from "@/components/mode-badge";
import { StatusDot } from "@/components/run-picker";
import { Progress } from "@/components/ui/progress";
import { formatDateTime, formatDuration } from "@/lib/format";
import type { RunDoc } from "@/lib/types";

export function RunHeader({ run }: { run: RunDoc }) {
  const pct = run.progress.total ? (run.progress.done / run.progress.total) * 100 : 0;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border bg-card px-4 py-3 text-[12px]">
      <div className="flex items-center gap-2">
        <StatusDot status={run.status} />
        <span className="text-[13px] font-medium">{run.label || run._id}</span>
        <span className="rounded bg-muted px-1.5 py-px text-[11px] text-muted-foreground">{run.status}</span>
      </div>
      <Meta label="Started">{formatDateTime(run.startedAt)}</Meta>
      <Meta label="Duration">{formatDuration(run.startedAt, run.finishedAt)}</Meta>
      <Meta label="Models">{run.models.length}</Meta>
      <Meta label="Modes">
        <span className="inline-flex gap-1">
          {run.modes.map((m) => (
            <ModeBadge key={m} mode={m} />
          ))}
          <ModeInfo />
        </span>
      </Meta>
      <Meta label="Filings">
        <span className="font-mono">
          {run.tickers.map((t, i) => (
            <span key={t}>
              {i > 0 ? " " : ""}
              <Link href={`/companies/${t}`} className="hover:underline">
                {t}
              </Link>
            </span>
          ))}
        </span>
      </Meta>
      <Meta label="Facts">{run.factIds.length}</Meta>
      <Meta label="Retrieval k">{run.config?.retrievalK ?? "—"}</Meta>
      {run.status === "running" ? (
        <div className="flex min-w-[180px] items-center gap-2">
          <Progress value={pct} className="h-1.5 w-28" />
          <span className="font-mono tabular-nums text-muted-foreground">
            {run.progress.done}/{run.progress.total}
          </span>
        </div>
      ) : null}
      {run.error ? <span className="text-red-700">{run.error}</span> : null}
      <Link
        href={`/runs/${encodeURIComponent(run._id)}`}
        className="ml-auto inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[12px] font-medium hover:bg-muted"
      >
        Results grid
        <ArrowRightIcon className="size-3.5" />
      </Link>
    </div>
  );
}

export function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{children}</span>
    </div>
  );
}
