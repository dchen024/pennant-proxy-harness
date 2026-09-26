"use client";

import { LockIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// UI for the read-only demo (NEXT_PUBLIC_READ_ONLY=true, see src/lib/readonly.ts). The server refuses
// every write on its own; these only explain why the controls are off.

export const READ_ONLY_HINT = "Viewing a snapshot. Starting runs, editing the answer key and approving changes are disabled.";

/** Top-nav badge. Below `sm` it shrinks to the lock icon (the label stays for screen readers). */
export function ReadOnlyBadge({ className }: { className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          data-read-only-badge
          className={cn(
            "inline-flex shrink-0 cursor-default items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-amber-900 outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          <LockIcon className="size-3" aria-hidden />
          <span className="max-sm:sr-only">Read-only demo</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{READ_ONLY_HINT}</TooltipContent>
    </Tooltip>
  );
}

/** One-line notice above (or inside) a page whose writes are disabled. */
export function ReadOnlyBanner({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      role="note"
      data-read-only-banner
      className={cn("flex items-center gap-2 bg-amber-50 px-4 py-1.5 text-[12px] text-amber-900", className)}
    >
      <LockIcon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}
