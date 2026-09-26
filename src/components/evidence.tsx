"use client";

import { useEffect, useState } from "react";
import { PdfHighlight } from "@/components/pdf-highlight-lazy";
import type { HighlightTone } from "@/components/pdf-highlight";
import { matchQuote } from "@/lib/highlight";
import type { BBox, ChunkLine, PageDim } from "@/lib/types";

export interface FilingView {
  ticker: string;
  company: string;
  pdfPath: string;
  sourceUrl?: string;
  filingDate?: string;
  pages: PageDim[];
}

export interface ChunkView {
  _id: string;
  ticker: string;
  page: number;
  kind?: "text" | "table";
  lines: ChunkLine[];
  bbox: BBox;
}

// ---------------------------------------------------------------------------
// Client-side chunk cache: chunks are immutable per parser version.
// ---------------------------------------------------------------------------

const chunkCache = new Map<string, ChunkView | null>();
const inflight = new Map<string, Promise<void>>();

async function loadChunks(ids: string[]): Promise<void> {
  const need = ids.filter((id) => !chunkCache.has(id) && !inflight.has(id));
  if (need.length > 0) {
    const p = fetch(`/api/chunks?ids=${need.map(encodeURIComponent).join(",")}`)
      .then((r) => (r.ok ? r.json() : { chunks: [] }))
      .then((data: { chunks: ChunkView[] }) => {
        for (const id of need) if (!chunkCache.has(id)) chunkCache.set(id, null);
        for (const c of data.chunks ?? []) chunkCache.set(c._id, c);
      })
      .catch(() => {
        for (const id of need) chunkCache.set(id, null);
      })
      .finally(() => {
        for (const id of need) inflight.delete(id);
      });
    for (const id of need) inflight.set(id, p);
  }
  await Promise.all(ids.map((id) => inflight.get(id)).filter(Boolean));
}

export function primeChunks(chunks: ChunkView[]) {
  for (const c of chunks) chunkCache.set(c._id, c);
}

/** Returns cached chunks for ids (undefined while loading, null when not found). */
export function useChunks(ids: (string | null | undefined)[]): Record<string, ChunkView | null | undefined> {
  const key = [...new Set(ids.filter((x): x is string => !!x))].sort().join(",");
  const [, setVersion] = useState(0);
  useEffect(() => {
    if (!key) return;
    const list = key.split(",");
    if (list.every((id) => chunkCache.has(id))) return;
    let live = true;
    loadChunks(list).then(() => {
      if (live) setVersion((v) => v + 1);
    });
    return () => {
      live = false;
    };
  }, [key]);
  const out: Record<string, ChunkView | null | undefined> = {};
  if (key) for (const id of key.split(",")) out[id] = chunkCache.get(id);
  return out;
}

/** Chunk ids are `${ticker}:p${page}:${index}`. */
export function pageFromChunkId(chunkId: string | null | undefined): number | null {
  const m = chunkId?.match(/:p(\d+):/);
  return m ? Number(m[1]) : null;
}

export function pageSize(filing: FilingView | undefined, page: number) {
  const dim = filing?.pages?.find((p) => p.page === page);
  return dim ? { width: dim.width, height: dim.height } : { width: 612, height: 792 };
}

/**
 * The PDF page of a cited chunk with the quoted lines highlighted. When only a page
 * is known (no chunk), the page is shown without highlights.
 */
export function EvidencePage({
  filing,
  chunkId,
  chunk,
  quote,
  page,
  width = 620,
  tone = "amber",
  secondary,
  caption,
  maxHeight,
}: {
  filing: FilingView | undefined;
  chunkId?: string | null;
  chunk: ChunkView | null | undefined;
  quote: string | null | undefined;
  page?: number | null;
  width?: number;
  tone?: HighlightTone;
  secondary?: BBox[];
  caption?: React.ReactNode;
  maxHeight?: number;
}) {
  if (!filing) {
    return <Notice>Filing PDF not available (no filing document in the database for this company).</Notice>;
  }
  if (chunkId && chunk === undefined) {
    return <div className="h-[420px] animate-pulse rounded-sm bg-neutral-100 ring-1 ring-border" style={{ width }} />;
  }
  const p = chunk?.page ?? page ?? pageFromChunkId(chunkId);
  if (!p) return <Notice>No page to show.</Notice>;
  const { boxes, matched } = chunk ? matchQuote(chunk.lines, quote) : { boxes: [] as BBox[], matched: false };
  return (
    <div className="space-y-2">
      {chunkId && chunk === null ? (
        <Notice tone="warn">
          Cited chunk <code className="font-mono">{chunkId}</code> does not exist in the parsed filing. Showing page {p}.
        </Notice>
      ) : null}
      {chunk && quote && !matched ? (
        <Notice tone="warn">Quote not found in the cited chunk; the whole chunk is outlined.</Notice>
      ) : null}
      <PdfHighlight
        fileUrl={filing.pdfPath}
        page={p}
        pageSize={pageSize(filing, p)}
        highlights={boxes}
        secondary={secondary}
        width={width}
        tone={tone}
        caption={caption}
        maxHeight={maxHeight}
      />
    </div>
  );
}

export function Notice({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "warn" }) {
  return (
    <div
      className={
        tone === "warn"
          ? "rounded border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-900"
          : "rounded border border-dashed px-3 py-6 text-center text-[12px] text-muted-foreground"
      }
    >
      {children}
    </div>
  );
}
