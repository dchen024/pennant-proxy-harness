"use client";

import { useRouter } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDateTime } from "@/lib/format";
import type { RunDoc } from "@/lib/types";

export type RunOption = Pick<RunDoc, "_id" | "label" | "status" | "startedAt" | "models" | "modes">;

export function RunPicker({ runs, value, basePath = "/" }: { runs: RunOption[]; value?: string; basePath?: string }) {
  const router = useRouter();
  if (runs.length === 0) return null;
  return (
    <Select
      value={value}
      onValueChange={(id) => router.push(`${basePath}?run=${encodeURIComponent(id)}`)}
    >
      <SelectTrigger className="h-8 w-[340px] text-[13px]" aria-label="Select run">
        <SelectValue placeholder="Select a run" />
      </SelectTrigger>
      <SelectContent position="popper" align="end" className="max-h-[420px] min-w-[420px]">
        {runs.map((r) => (
          <SelectItem key={r._id} value={r._id} className="text-[13px]">
            <span className="flex w-full items-center gap-2">
              <StatusDot status={r.status} />
              <span className="truncate">{r.label || r._id}</span>
              <span className="ml-auto pl-3 text-[11px] text-muted-foreground tabular-nums">
                {formatDateTime(r.startedAt)} · {r.models.length}m × {r.modes.length}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function StatusDot({ status }: { status: RunDoc["status"] }) {
  const cls =
    status === "running"
      ? "bg-sky-500 animate-pulse"
      : status === "done"
        ? "bg-emerald-500"
        : "bg-red-500";
  return <span className={`inline-block size-1.5 shrink-0 rounded-full ${cls}`} aria-label={status} />;
}
