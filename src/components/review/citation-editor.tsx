"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, Loader2Icon, SaveIcon, SearchIcon } from "lucide-react";
import { pageFromChunkId, pageSize, type ChunkView, type FilingView } from "@/components/evidence";
import { PdfHighlight } from "@/components/pdf-highlight-lazy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatQuote } from "@/lib/format";
import { matchQuote, quoteLineIndices } from "@/lib/highlight";
import type { BBox } from "@/lib/types";
import { READ_ONLY } from "@/lib/readonly";
import { cn } from "@/lib/utils";

export interface Citation {
  chunkId: string;
  quote: string;
  page: number;
}

interface SearchHit {
  chunkId: string;
  page: number;
  lineStart: number;
  lineEnd: number;
  snippet: string;
}

/** A contiguous run of lines inside one chunk. `anchor` is where shift+click extends from. */
interface Selection {
  chunk: ChunkView;
  start: number;
  end: number;
  anchor: number;
}

// ---------------------------------------------------------------------------
// Page chunk cache: chunks are immutable per parser version.
// ---------------------------------------------------------------------------

const pageCache = new Map<string, ChunkView[]>();
const pageInflight = new Map<string, Promise<ChunkView[]>>();

function pageKey(ticker: string, parser: string, page: number) {
  return `${ticker}:${parser}:${page}`;
}

function loadPage(ticker: string, parser: string, page: number): Promise<ChunkView[]> {
  const key = pageKey(ticker, parser, page);
  const cached = pageCache.get(key);
  if (cached) return Promise.resolve(cached);
  let p = pageInflight.get(key);
  if (!p) {
    p = fetch(`/api/chunks?ticker=${encodeURIComponent(ticker)}&page=${page}&parser=${encodeURIComponent(parser)}`)
      .then(async (r) => {
        const data = (await r.json().catch(() => ({}))) as { chunks?: ChunkView[]; error?: string };
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        const list = data.chunks ?? [];
        pageCache.set(key, list);
        return list;
      })
      .finally(() => pageInflight.delete(key));
    pageInflight.set(key, p);
  }
  return p;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function quoteOf(sel: Selection): string {
  return sel.chunk.lines
    .slice(sel.start, sel.end + 1)
    .map((l) => l.text)
    .join(" ");
}

/**
 * Lets the reviewer pick the evidence passage by hand: every line of every chunk on the
 * page is clickable; shift+click extends within the same chunk. The resulting quote is the
 * selected lines' verbatim text, so citation checks (normalized containment) always pass.
 */
export function CitationEditor({
  ticker,
  filing,
  parser,
  width,
  initial,
  initialLabel = "saved citation",
  saving,
  error,
  verifyLabel,
  canVerify,
  onCancel,
  onSave,
}: {
  ticker: string;
  filing: FilingView;
  /** Parser version whose chunks are cited, e.g. "v2" or "v3". */
  parser: string;
  width: number;
  /** The citation being edited, shown in amber and pre-selected when it matches whole lines. */
  initial: { chunkId: string | null; quote: string | null; page: number | null };
  /** Legend for the amber highlight, e.g. "saved citation". */
  initialLabel?: string;
  saving: boolean;
  error: string | null;
  /** e.g. "as $74,294,811"; shown on the Save & verify button. */
  verifyLabel: string;
  canVerify: boolean;
  onCancel: () => void;
  onSave: (citation: Citation, verify: boolean) => void;
}) {
  const pageCount = Math.max(1, filing.pages.length);
  const [startPage] = useState(() => clamp(initial.page ?? pageFromChunkId(initial.chunkId) ?? 1, 1, pageCount));
  const [page, setPage] = useState(startPage);
  const [pageInput, setPageInput] = useState(String(startPage));
  const [, setLoaded] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [jump, setJump] = useState(0);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ q: string; hits: SearchHit[]; total: number; error?: string } | null>(null);
  const [showResults, setShowResults] = useState(false);
  const [activeHit, setActiveHit] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  const chunks = pageCache.get(pageKey(ticker, parser, page)) ?? null;

  // Load the page's chunks (and warm the neighbours).
  useEffect(() => {
    let live = true;
    loadPage(ticker, parser, page)
      .then(() => {
        if (!live) return;
        setLoadError(null);
        setLoaded((v) => v + 1);
        for (const n of [page - 1, page + 1]) if (n >= 1 && n <= pageCount) void loadPage(ticker, parser, n).catch(() => {});
      })
      .catch((err: unknown) => {
        if (live) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [ticker, parser, page, pageCount]);

  // Until the reviewer clicks, start from the saved citation when it covers whole lines.
  const initialSelection = useMemo<Selection | null>(() => {
    if (!initial.chunkId || !initial.quote) return null;
    const list = pageCache.get(pageKey(ticker, parser, startPage));
    const chunk = list?.find((c) => c._id === initial.chunkId);
    if (!chunk) return null;
    const hit = quoteLineIndices(chunk.lines, initial.quote).indices;
    if (hit.length === 0) return null;
    const start = Math.min(...hit);
    const end = Math.max(...hit);
    return { chunk, start, end, anchor: start };
    // `chunks` changes when the start page finishes loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.chunkId, initial.quote, ticker, parser, startPage, chunks]);
  const sel = touched ? selection : initialSelection;

  // Debounced search over this filing's chunks.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(
        `/api/search?ticker=${encodeURIComponent(ticker)}&parser=${encodeURIComponent(parser)}&q=${encodeURIComponent(q)}`,
        { signal: ctrl.signal },
      )
        .then(async (r) => {
          const d = (await r.json().catch(() => ({}))) as { hits?: SearchHit[]; total?: number; error?: string };
          setResults({ q, hits: d.hits ?? [], total: d.total ?? 0, error: r.ok ? undefined : d.error || `HTTP ${r.status}` });
          setActiveHit(0);
        })
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query, ticker, parser]);

  const goToPage = (n: number) => {
    if (!Number.isFinite(n) || n < 1) {
      setPageInput(String(page));
      return;
    }
    const p = clamp(Math.round(n), 1, pageCount);
    setPage(p);
    setPageInput(String(p));
    setJump((j) => j + 1);
  };

  const goToHit = async (hit: SearchHit) => {
    setShowResults(false);
    searchRef.current?.blur();
    let list: ChunkView[] = [];
    try {
      list = await loadPage(ticker, parser, hit.page);
    } catch {
      // the page view reports the load error
    }
    const chunk = list.find((c) => c._id === hit.chunkId);
    setPage(hit.page);
    setPageInput(String(hit.page));
    if (chunk) {
      setTouched(true);
      setSelection({ chunk, start: hit.lineStart, end: hit.lineEnd, anchor: hit.lineStart });
    }
    setJump((j) => j + 1);
  };

  const clickLine = (chunk: ChunkView, index: number, shift: boolean) => {
    setTouched(true);
    if (shift && sel && sel.chunk._id === chunk._id) {
      setSelection({ chunk, anchor: sel.anchor, start: Math.min(sel.anchor, index), end: Math.max(sel.anchor, index) });
    } else if (!shift && sel && sel.chunk._id === chunk._id && sel.start === index && sel.end === index) {
      setSelection(null); // clicking the only selected line clears it
    } else {
      setSelection({ chunk, start: index, end: index, anchor: index });
    }
  };

  // Keyboard: Esc cancels; / focuses search; [ ] or arrows turn pages.
  const goToPageRef = useRef(goToPage);
  const cancelRef = useRef(onCancel);
  const pageRef = useRef(page);
  useEffect(() => {
    goToPageRef.current = goToPage;
    cancelRef.current = onCancel;
    pageRef.current = page;
  });
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        e.preventDefault();
        cancelRef.current();
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "[" || e.key === "ArrowLeft") {
        e.preventDefault();
        goToPageRef.current(pageRef.current - 1);
      } else if (e.key === "]" || e.key === "ArrowRight") {
        e.preventDefault();
        goToPageRef.current(pageRef.current + 1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selectedBoxes: BBox[] =
    sel && sel.chunk.page === page ? sel.chunk.lines.slice(sel.start, sel.end + 1).map((l) => l.bbox) : [];
  const savedChunk = initial.chunkId ? chunks?.find((c) => c._id === initial.chunkId) : undefined;
  const savedBoxes = savedChunk ? matchQuote(savedChunk.lines, initial.quote).boxes : undefined;
  const quote = sel ? quoteOf(sel) : "";
  const q = query.trim();
  const hitsFresh = results && results.q === q ? results : null;

  const box = (b: BBox, scale: number, pad: number) => ({
    left: b[0] * scale - pad,
    top: b[1] * scale - pad,
    width: Math.max(3, (b[2] - b[0]) * scale + 2 * pad),
    height: Math.max(3, (b[3] - b[1]) * scale + 2 * pad),
  });

  return (
    <div className="space-y-2" data-citation-editor>
      {/* Toolbar */}
      <div className="sticky top-0 z-30 -mx-4 -mt-4 border-b bg-background/95 px-4 pt-3 pb-2.5 backdrop-blur">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold">Edit citation</span>
          <span className="truncate text-[11px] text-muted-foreground">
            Click a line · shift+click extends within one passage · parser {parser}
          </span>
          <Button variant="ghost" size="xs" onClick={onCancel} className="ml-auto" disabled={saving}>
            Cancel <kbd className="rounded border px-1 font-mono text-[10px]">Esc</kbd>
          </Button>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Previous page"
              onClick={() => goToPage(page - 1)}
              disabled={page <= 1}
            >
              <ChevronLeftIcon />
            </Button>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                goToPage(Number(pageInput));
                // Give the keyboard back to [ ] / shortcuts.
                (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.blur();
              }}
              className="flex items-center gap-1"
            >
              <Input
                aria-label="Page number"
                value={pageInput}
                inputMode="numeric"
                onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ""))}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={() => {
                  if (pageInput === "" || Number(pageInput) === page) setPageInput(String(page));
                  else goToPage(Number(pageInput));
                }}
                className="h-7 w-12 px-1 text-center font-mono text-[12px] tabular-nums"
              />
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">/ {pageCount}</span>
            </form>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Next page"
              onClick={() => goToPage(page + 1)}
              disabled={page >= pageCount}
            >
              <ChevronRightIcon />
            </Button>
          </div>
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={query}
              aria-label="Search this filing"
              placeholder="Find in this filing   /"
              onChange={(e) => {
                setQuery(e.target.value);
                setShowResults(true);
              }}
              onFocus={() => setShowResults(true)}
              onBlur={() => setShowResults(false)}
              onKeyDown={(e) => {
                const hits = hitsFresh?.hits ?? [];
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveHit((i) => Math.min(hits.length - 1, i + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveHit((i) => Math.max(0, i - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const hit = hits[activeHit] ?? hits[0];
                  if (hit) void goToHit(hit);
                }
              }}
              className="h-7 pl-7 text-[12px]"
            />
            {showResults && q.length >= 2 ? (
              <div
                className="absolute top-full right-0 left-0 z-40 mt-1 max-h-[360px] overflow-y-auto rounded-md border bg-popover p-1 shadow-lg"
                onMouseDown={(e) => e.preventDefault()}
              >
                {!hitsFresh ? (
                  <div className="flex items-center gap-2 px-2 py-2 text-[12px] text-muted-foreground">
                    <Loader2Icon className="size-3.5 animate-spin" /> Searching…
                  </div>
                ) : hitsFresh.error ? (
                  <div className="px-2 py-2 text-[12px] text-red-700">{hitsFresh.error}</div>
                ) : hitsFresh.hits.length === 0 ? (
                  <div className="px-2 py-2 text-[12px] text-muted-foreground">No matches in this filing.</div>
                ) : (
                  <>
                    <div className="px-2 pt-1 pb-1.5 text-[10.5px] text-muted-foreground">
                      {hitsFresh.total > hitsFresh.hits.length
                        ? `First ${hitsFresh.hits.length} of ${hitsFresh.total} matches`
                        : `${hitsFresh.total} match${hitsFresh.total === 1 ? "" : "es"}`}
                    </div>
                    {hitsFresh.hits.map((h, i) => (
                      <button
                        key={`${h.chunkId}:${h.lineStart}:${i}`}
                        type="button"
                        data-search-hit
                        onClick={() => void goToHit(h)}
                        onMouseEnter={() => setActiveHit(i)}
                        className={cn(
                          "flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left",
                          i === activeHit ? "bg-muted" : "hover:bg-muted/60",
                        )}
                      >
                        <span className="w-10 shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">p. {h.page}</span>
                        <span className="line-clamp-2 text-[12px] leading-snug">
                          <Snippet text={formatQuote(h.snippet)} query={q} />
                        </span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {loadError ? (
        <div className="rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-[12px] text-red-900">
          Could not load the passages on page {page}: {loadError}
        </div>
      ) : chunks && chunks.length === 0 ? (
        <div className="rounded border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-900">
          No parsed text on page {page} (parser {parser}); nothing here can be cited.
        </div>
      ) : null}

      {/* Page with every line clickable */}
      <PdfHighlight
        fileUrl={filing.pdfPath}
        page={page}
        pageSize={pageSize(filing, page)}
        width={width}
        highlights={selectedBoxes}
        tone="violet"
        secondary={savedBoxes}
        secondaryTone="amber"
        scrollKey={`${page}:${jump}`}
        caption={
          <span className="inline-flex items-center gap-2">
            <span className="inline-flex items-center gap-1">
              <span className="inline-block size-2.5 rounded-[2px] bg-violet-400/50 ring-1 ring-violet-600" /> selection
            </span>
            {savedBoxes?.length ? (
              <span className="inline-flex items-center gap-1">
                <span className="inline-block size-2.5 rounded-[2px] bg-amber-300/60 ring-1 ring-amber-500" /> {initialLabel}
              </span>
            ) : null}
          </span>
        }
        overlay={(scale) => (
          <div
            className="absolute inset-0 select-none"
            onMouseDown={(e) => {
              if (e.shiftKey) e.preventDefault(); // no native text selection on shift+click
            }}
          >
            {(chunks ?? []).map((c) => (
              <div key={c._id}>
                <div
                  className="pointer-events-none absolute rounded-[3px] border border-dashed border-sky-600/25"
                  style={box(c.bbox, scale, 3)}
                />
                {c.lines.map((l, i) => {
                  const selected = !!sel && sel.chunk._id === c._id && i >= sel.start && i <= sel.end;
                  return (
                    <div
                      key={i}
                      role="button"
                      tabIndex={-1}
                      data-line={`${c._id}#${i}`}
                      title={`${c._id} · line ${i + 1}\n${l.text}`}
                      onClick={(e) => clickLine(c, i, e.shiftKey)}
                      className={cn(
                        "absolute cursor-pointer rounded-[2px] transition-colors",
                        selected ? "hover:bg-violet-500/10" : "hover:bg-sky-400/20 hover:ring-1 hover:ring-sky-600/70",
                      )}
                      style={box(l.bbox, scale, 1.5)}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        )}
      />

      {/* Preview + actions */}
      <div className="sticky bottom-0 z-30 -mx-4 -mb-4 space-y-2 border-t bg-background/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">New citation</span>
          {sel ? (
            <span className="truncate font-mono text-[11px] text-muted-foreground" data-citation-meta>
              {sel.chunk._id} · p. {sel.chunk.page} · {sel.end - sel.start + 1} line{sel.end > sel.start ? "s" : ""}
              {sel.chunk.page !== page ? " (not on this page)" : ""}
            </span>
          ) : null}
        </div>
        {sel ? (
          <blockquote
            className="max-h-28 overflow-y-auto border-l-2 border-violet-500 bg-violet-50/60 py-1.5 pr-2 pl-3 font-serif text-[12.5px] leading-relaxed"
            data-citation-quote
          >
            {quote}
          </blockquote>
        ) : (
          <p className="text-[12px] text-muted-foreground">
            Click the line(s) on the page that support this fact, or search the filing.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={READ_ONLY || !sel || saving}
            onClick={() => sel && onSave({ chunkId: sel.chunk._id, quote, page: sel.chunk.page }, false)}
          >
            {saving ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
            Save citation
          </Button>
          <Button
            size="sm"
            disabled={READ_ONLY || !sel || saving || !canVerify}
            onClick={() => sel && onSave({ chunkId: sel.chunk._id, quote, page: sel.chunk.page }, true)}
          >
            {saving ? <Loader2Icon className="animate-spin" /> : <CheckIcon />}
            Save &amp; verify <span className="font-mono text-[11px] opacity-80">{verifyLabel}</span>
          </Button>
          {READ_ONLY ? (
            <span className="text-[12px] text-muted-foreground" data-read-only-note>
              Saving is disabled in the read-only demo.
            </span>
          ) : null}
          {error ? <span className="text-[12px] text-red-700">{error}</span> : null}
        </div>
      </div>
    </div>
  );
}

/** Snippet with the (first) query match emphasised, when it can be found verbatim. */
function Snippet({ text, query }: { text: string; query: string }) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[2px] bg-amber-200/80 px-0.5 text-inherit">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}
