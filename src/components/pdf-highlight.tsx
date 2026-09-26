"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { ExternalLinkIcon } from "lucide-react";
import type { BBox } from "@/lib/types";
import { cn } from "@/lib/utils";

// Must be set in the same module that renders <Document>/<Page> (see react-pdf docs).
// The worker is copied to /public by `pnpm copy:pdf-worker` (runs on postinstall).
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

/** "none" draws nothing: useful as an invisible scroll target. */
export type HighlightTone = "amber" | "sky" | "emerald" | "rose" | "violet" | "none";

const TONES: Record<HighlightTone, string> = {
  amber: "bg-amber-300/35 ring-amber-500/70",
  sky: "bg-sky-300/30 ring-sky-500/70",
  emerald: "bg-emerald-300/30 ring-emerald-600/70",
  rose: "bg-rose-300/30 ring-rose-500/70",
  violet: "bg-violet-400/35 ring-violet-600/80",
  none: "bg-transparent ring-0",
};

export interface PdfHighlightProps {
  fileUrl: string;
  page: number;
  pageSize: { width: number; height: number };
  highlights: BBox[];
  width?: number;
  tone?: HighlightTone;
  /** Extra highlight set drawn in a second color (e.g. a second model's citation on the same page). */
  secondary?: BBox[];
  secondaryTone?: HighlightTone;
  caption?: React.ReactNode;
  className?: string;
  /** When set, the page scrolls inside a viewport of this height (px) instead of the page/sheet. */
  maxHeight?: number;
  /** Extra absolutely-positioned content over the page (e.g. clickable line boxes), given the px-per-point scale. */
  overlay?: (scale: number) => React.ReactNode;
  /**
   * When set, the view scrolls (to the first highlight, or to the top of the page when there is none)
   * only when this key changes, instead of whenever the highlights change.
   */
  scrollKey?: string;
}

const PAD = 2;

function scrollParent(el: HTMLElement): HTMLElement | null {
  let p = el.parentElement;
  while (p) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
    p = p.parentElement;
  }
  return null;
}

export default function PdfHighlight({
  fileUrl,
  page,
  pageSize,
  highlights,
  width = 600,
  tone = "amber",
  secondary,
  secondaryTone = "sky",
  caption,
  className,
  maxHeight,
  overlay,
  scrollKey,
}: PdfHighlightProps) {
  const scale = width / (pageSize.width || 612);
  const height = Math.round((pageSize.height || 792) * scale);
  const firstRef = useRef<HTMLDivElement>(null);
  const [renderedKey, setRenderedKey] = useState<string | null>(null);
  const pageKey = `${fileUrl}#${page}@${width}`;
  const rendered = renderedKey === pageKey;
  const hlKey = useMemo(() => scrollKey ?? JSON.stringify(highlights[0] ?? null), [highlights, scrollKey]);

  // Bring the first highlight into view once the page has painted (and whenever it moves).
  useEffect(() => {
    if (!rendered) return;
    const el = firstRef.current;
    if (!el) return;
    const parent = scrollParent(el);
    if (!parent) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    const er = el.getBoundingClientRect();
    const pr = parent.getBoundingClientRect();
    const target =
      el.dataset.marker === "top"
        ? parent.scrollTop + (er.top - pr.top) - 72
        : parent.scrollTop + (er.top - pr.top) - parent.clientHeight / 2 + er.height / 2;
    parent.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, [rendered, hlKey]);

  const box = (b: BBox) => ({
    left: b[0] * scale - PAD,
    top: b[1] * scale - PAD,
    width: Math.max(2, (b[2] - b[0]) * scale + 2 * PAD),
    height: Math.max(2, (b[3] - b[1]) * scale + 2 * PAD),
  });

  return (
    <div className={cn("flex flex-col gap-1.5", className)} style={{ width }}>
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="font-mono tabular-nums">
          p. {page}
          {caption ? <span className="ml-2 font-sans">{caption}</span> : null}
        </span>
        <a
          href={`${fileUrl}#page=${page}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
        >
          Open PDF at p. {page}
          <ExternalLinkIcon className="size-3" />
        </a>
      </div>
      <div
        className={cn("rounded-sm ring-1 ring-border", maxHeight ? "overflow-y-auto overscroll-contain" : "")}
        style={maxHeight ? { width: width + 2, maxHeight } : undefined}
      >
      <div
        className="relative overflow-hidden bg-white shadow-sm"
        style={{ width, height }}
      >
        <Document
          file={fileUrl}
          suspense={false}
          loading={<PageSkeleton />}
          error={<PageError message={`Could not load ${fileUrl}`} />}
          noData={<PageError message="No PDF" />}
        >
          <Page
            pageNumber={page}
            width={width}
            suspense={false}
            renderTextLayer={false}
            renderAnnotationLayer={false}
            loading={<PageSkeleton />}
            error={<PageError message={`Could not render page ${page}`} />}
            onRenderSuccess={() => setRenderedKey(pageKey)}
          />
        </Document>
        {secondary?.map((b, i) => (
          <div
            key={`s${i}`}
            className={cn("pointer-events-none absolute rounded-[2px] mix-blend-multiply ring-1", TONES[secondaryTone])}
            style={box(b)}
          />
        ))}
        {highlights.map((b, i) => (
          <div
            key={`h${i}`}
            ref={i === 0 ? firstRef : undefined}
            className={cn("pointer-events-none absolute rounded-[2px] mix-blend-multiply ring-1", TONES[tone])}
            style={box(b)}
          />
        ))}
        {highlights.length === 0 && scrollKey ? (
          <div ref={firstRef} data-marker="top" aria-hidden className="pointer-events-none absolute top-0 left-0 size-px" />
        ) : null}
        {overlay?.(scale)}
      </div>
      </div>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="absolute inset-0 flex animate-pulse flex-col gap-2 bg-neutral-50 p-8">
      {Array.from({ length: 14 }).map((_, i) => (
        <div key={i} className="h-2 rounded bg-neutral-200" style={{ width: `${55 + ((i * 37) % 40)}%` }} />
      ))}
    </div>
  );
}

function PageError({ message }: { message: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-neutral-50 p-6 text-center text-xs text-muted-foreground">
      {message}
    </div>
  );
}
