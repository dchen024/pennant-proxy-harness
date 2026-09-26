import { cn } from "@/lib/utils";
import type { Stage } from "@/lib/types";

// Order is also the stacking order of StageBar. It keeps red away from green and orange
// (validated for colour-vision deficiency), and the bar keeps 2px gaps + a legend.
export const STAGE_ORDER: Stage[] = ["ok", "citation", "extraction", "parse", "retrieval", "format", "api"];

export const STAGE_META: Record<
  Stage,
  { label: string; description: string; color: string; cell: string; chip: string }
> = {
  ok: {
    label: "OK",
    description: "Correct value with a supporting citation.",
    color: "#16a34a",
    cell: "bg-emerald-50 text-emerald-950 border-l-emerald-600 hover:bg-emerald-100",
    chip: "bg-emerald-50 text-emerald-800 ring-emerald-600/25",
  },
  extraction: {
    label: "Extraction",
    description: "The evidence was in the model's context, but the value it extracted is wrong.",
    color: "#dc2626",
    cell: "bg-red-50 text-red-950 border-l-red-600 hover:bg-red-100",
    chip: "bg-red-50 text-red-800 ring-red-600/25",
  },
  retrieval: {
    label: "Retrieval",
    description: "The gold evidence exists in the parsed filing but was not in the retrieved context.",
    color: "#fb923c",
    cell: "bg-orange-50 text-orange-950 border-l-orange-500 hover:bg-orange-100",
    chip: "bg-orange-50 text-orange-800 ring-orange-600/25",
  },
  parse: {
    label: "Parse",
    description: "The gold evidence is not present in any parsed chunk (lost at PDF parsing).",
    color: "#9333ea",
    cell: "bg-purple-50 text-purple-950 border-l-purple-600 hover:bg-purple-100",
    chip: "bg-purple-50 text-purple-800 ring-purple-600/25",
  },
  citation: {
    label: "Citation",
    description: "The value is right, but the cited quote/chunk does not support it.",
    color: "#fbbf24",
    cell: "bg-amber-50 text-amber-950 border-l-amber-500 hover:bg-amber-100",
    chip: "bg-amber-50 text-amber-800 ring-amber-600/30",
  },
  format: {
    label: "Format",
    description: "The model output could not be parsed into the schema (after one repair attempt).",
    color: "#a3a3a3",
    cell: "bg-neutral-200/80 text-neutral-800 border-l-neutral-400 hover:bg-neutral-300/70",
    chip: "bg-neutral-100 text-neutral-700 ring-neutral-500/25",
  },
  api: {
    label: "API",
    description: "Provider/API error or timeout.",
    color: "#171717",
    cell: "bg-neutral-900 text-neutral-50 border-l-black hover:bg-neutral-800",
    chip: "bg-neutral-900 text-neutral-50 ring-neutral-900",
  },
};

export function StageChip({ stage, className }: { stage: Stage | null; className?: string }) {
  if (!stage) {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground ring-1 ring-inset ring-border",
          className,
        )}
      >
        No gold
      </span>
    );
  }
  const meta = STAGE_META[stage];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset",
        meta.chip,
        className,
      )}
    >
      <span className="size-1.5 rounded-full" style={{ background: meta.color }} />
      {meta.label}
    </span>
  );
}

/** Compact horizontal stacked bar of stage counts. */
export function StageBar({
  byStage,
  className,
  height = 8,
}: {
  byStage: Partial<Record<Stage, number>>;
  className?: string;
  height?: number;
}) {
  const total = STAGE_ORDER.reduce((s, k) => s + (byStage[k] ?? 0), 0);
  if (total === 0) {
    return <div className={cn("w-full rounded-sm bg-muted", className)} style={{ height }} />;
  }
  const title = STAGE_ORDER.filter((k) => byStage[k])
    .map((k) => `${STAGE_META[k].label}: ${byStage[k]}`)
    .join(" · ");
  return (
    <div
      className={cn("flex w-full overflow-hidden rounded-sm bg-muted", className)}
      style={{ height }}
      title={title}
      role="img"
      aria-label={title}
    >
      {STAGE_ORDER.map((k) => {
        const n = byStage[k] ?? 0;
        if (!n) return null;
        return (
          <div
            key={k}
            className="h-full border-r-2 border-card last:border-r-0"
            style={{ width: `${(n / total) * 100}%`, background: STAGE_META[k].color }}
          />
        );
      })}
    </div>
  );
}

export function StageLegend({ className, showNoGold = false }: { className?: string; showNoGold?: boolean }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground", className)}>
      {STAGE_ORDER.map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5" title={STAGE_META[k].description}>
          <span className="size-2.5 rounded-[2px]" style={{ background: STAGE_META[k].color }} />
          {STAGE_META[k].label}
        </span>
      ))}
      {showNoGold && (
        <span className="inline-flex items-center gap-1.5" title="No verified gold answer to grade against.">
          <span className="size-2.5 rounded-[2px] ring-1 ring-inset ring-neutral-400" />
          No gold
        </span>
      )}
    </div>
  );
}
