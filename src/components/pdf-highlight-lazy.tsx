"use client";

import dynamic from "next/dynamic";
import type { PdfHighlightProps } from "./pdf-highlight";

// react-pdf touches browser-only APIs (canvas, workers), so it is never server-rendered.
const PdfHighlightInner = dynamic(() => import("./pdf-highlight"), {
  ssr: false,
  loading: () => (
    <div className="h-[420px] w-full animate-pulse rounded-sm bg-neutral-100 ring-1 ring-border" />
  ),
});

export function PdfHighlight(props: PdfHighlightProps) {
  return <PdfHighlightInner {...props} />;
}

export type { PdfHighlightProps };
