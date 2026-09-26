import { InfoIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// UI names for the two run modes. Data and URLs keep the ids "e2e" and "oracle".
export const MODE_LABEL: Record<string, string> = { e2e: "Full pipeline", oracle: "Reading only" };
export const MODE_SHORT: Record<string, string> = { e2e: "Full", oracle: "Reading" };
export const MODE_HELP =
  "Full pipeline: the model sees the passages our search retrieved. Reading only: the model is handed the human-verified evidence passage, so any error is about reading, not search.";

export const modeLabel = (mode: string) => MODE_LABEL[mode] ?? mode;

export function ModeBadge({ mode, short, className }: { mode: string; short?: boolean; className?: string }) {
  return (
    <span
      title={short ? modeLabel(mode) : undefined}
      className={cn(
        "inline-flex items-center rounded px-1.5 py-px text-[10.5px] font-medium whitespace-nowrap ring-1 ring-inset",
        mode === "oracle" ? "bg-violet-50 text-violet-800 ring-violet-600/20" : "bg-sky-50 text-sky-800 ring-sky-600/20",
        className,
      )}
    >
      {short ? (MODE_SHORT[mode] ?? mode) : modeLabel(mode)}
    </span>
  );
}

/** Info icon explaining the two modes; place it where a mode first appears. */
export function ModeInfo({ className, side = "top" }: { className?: string; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={MODE_HELP}
          data-mode-info
          className={cn("inline-flex cursor-help items-center align-middle text-muted-foreground hover:text-foreground", className)}
        >
          <InfoIcon className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className="block max-w-80 text-[11.5px] leading-snug">
        <b>Full pipeline:</b> the model sees the passages our search retrieved. <b>Reading only:</b> the model is handed
        the human-verified evidence passage, so any error is about reading, not search.
      </TooltipContent>
    </Tooltip>
  );
}
