"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangleIcon, CheckIcon, ChevronRightIcon, MinusIcon, XIcon } from "lucide-react";
import { EvidencePage, useChunks, type FilingView } from "@/components/evidence";
import { ModeBadge, ModeInfo } from "@/components/mode-badge";
import { STAGE_META, StageChip } from "@/components/stage";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FACT_BY_ID } from "@/lib/facts";
import { formatCost, formatInt, formatMs, formatQuote, formatValue, shortModel } from "@/lib/format";
import type { FactResult, GoldFact } from "@/lib/types";
import { cn } from "@/lib/utils";

export type ResultRow = Omit<FactResult, "raw"> & { raw?: string };
export type GoldView = Pick<GoldFact, "_id" | "ticker" | "factId" | "value" | "page" | "quote" | "chunkId" | "status">;

const fullCache = new Map<string, FactResult>();

function useFullResult(id: string | null): FactResult | null {
  const [, setV] = useState(0);
  useEffect(() => {
    if (!id || fullCache.has(id)) return;
    let live = true;
    fetch(`/api/results?id=${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { result?: FactResult } | null) => {
        if (d?.result) fullCache.set(id, d.result);
        if (live) setV((v) => v + 1);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id]);
  return id ? (fullCache.get(id) ?? null) : null;
}

function Check({ value, label, hint }: { value: boolean | null | undefined; label: string; hint: string }) {
  return (
    <div className="flex items-start gap-2" title={hint}>
      <span
        className={cn(
          "mt-px inline-flex size-4 shrink-0 items-center justify-center rounded-sm",
          value === true && "bg-emerald-100 text-emerald-700",
          value === false && "bg-red-100 text-red-700",
          (value === null || value === undefined) && "bg-muted text-muted-foreground",
        )}
      >
        {value === true ? <CheckIcon className="size-3" /> : value === false ? <XIcon className="size-3" /> : <MinusIcon className="size-3" />}
      </span>
      <div>
        <div className="text-[12px] font-medium">{label}</div>
        <div className="text-[11px] text-muted-foreground">{hint}</div>
      </div>
    </div>
  );
}

function KV({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-dashed py-1 last:border-b-0">
      <span className="text-[11px] text-muted-foreground">{k}</span>
      <span className="text-right font-mono text-[12px] tabular-nums">{children}</span>
    </div>
  );
}

export function ResultSheet({
  result,
  gold,
  filing,
  open,
  onOpenChange,
}: {
  result: ResultRow | null;
  gold: GoldView | undefined;
  filing: FilingView | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const full = useFullResult(open && result ? result._id : null);
  const r = full ?? result;
  const citedId = r?.extraction?.chunkId ?? null;
  const goldChunkId = gold?.chunkId ?? null;
  const chunks = useChunks([citedId, goldChunkId]);

  if (!r) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full data-[side=right]:sm:max-w-[720px]" />
      </Sheet>
    );
  }

  const def = FACT_BY_ID[r.factId];
  const ex = r.extraction;
  const hasGoldEvidence = !!gold && (!!gold.chunkId || !!gold.page);
  const goldRetrieved = goldChunkId ? r.retrievedChunkIds?.includes(goldChunkId) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto data-[side=right]:sm:max-w-[720px]">
        <SheetHeader className="border-b px-5 pt-4 pb-3">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Link href={`/companies/${r.ticker}`} className="font-mono font-medium text-foreground hover:underline">
              {r.ticker}
            </Link>
            {filing ? <span>{filing.company}</span> : null}
            <ChevronRightIcon className="size-3" />
            <span className="font-mono">{shortModel(r.model)}</span>
            <ModeBadge mode={r.mode} />
            <ModeInfo />
          </div>
          <SheetTitle className="text-base">{def?.label ?? r.factId}</SheetTitle>
          <SheetDescription className="text-[12px]">{def?.description}</SheetDescription>
        </SheetHeader>

        <div className="space-y-5 px-5 py-4">
          {/* Value vs gold */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md border px-3 py-2.5">
              <div className="text-[11px] text-muted-foreground">Extracted</div>
              <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums">
                {ex ? formatValue(ex.value, r.factId) : <span className="text-muted-foreground">no output</span>}
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                FY {ex?.fiscalYear ?? "—"}
                {r.repaired ? <span className="ml-2 text-amber-700">repaired after a malformed reply</span> : null}
              </div>
            </div>
            <div className="rounded-md border bg-muted/30 px-3 py-2.5">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>Gold (answer key)</span>
                {gold ? <span className="rounded bg-background px-1 py-px ring-1 ring-border">{gold.status}</span> : null}
              </div>
              <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums">
                {r.hasGold ? formatValue(r.gold, r.factId) : <span className="text-muted-foreground">not graded</span>}
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {gold?.page ? `Evidence on p. ${gold.page}` : "No evidence page"}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <StageChip stage={r.stage} />
            {r.correct === true ? (
              <span className="text-[12px] text-emerald-700">Correct</span>
            ) : r.correct === false ? (
              <span className="text-[12px] text-red-700">Incorrect</span>
            ) : null}
            {r.consequential ? (
              <span className="inline-flex items-center gap-1 rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-medium text-white">
                <AlertTriangleIcon className="size-3" />
                Consequential: flips a vote
              </span>
            ) : r.consequential === false && r.correct === false ? (
              <span className="text-[11px] text-muted-foreground">Not consequential (no vote changes)</span>
            ) : null}
            {r.stage ? <span className="text-[11px] text-muted-foreground">{STAGE_META[r.stage].description}</span> : null}
          </div>

          {r.error ? (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 font-mono text-[11px] break-words text-red-900">
              {r.error}
            </div>
          ) : null}

          {/* Quote */}
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Quote</div>
            {ex?.quote ? (
              <blockquote className="border-l-2 border-amber-400 bg-amber-50/50 py-1.5 pr-2 pl-3 font-serif text-[13px] leading-relaxed">
                “{formatQuote(ex.quote)}”
              </blockquote>
            ) : (
              <div className="text-[12px] text-muted-foreground">No quote given.</div>
            )}
            <div className="mt-1 font-mono text-[11px] text-muted-foreground">chunk {ex?.chunkId ?? "—"}</div>
          </div>

          {/* Checks */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Check value={r.checks?.quoteInChunk} label="Quote in chunk" hint="Quote appears (normalized) in the cited chunk." />
            <Check value={r.checks?.valueInQuote} label="Value in quote" hint="A number in the quote matches the value." />
            <Check value={r.checks?.pageMatchesGold} label="Page matches gold" hint="Cited chunk is on the gold evidence page." />
          </div>

          {/* Evidence */}
          <Tabs key={r._id} defaultValue="cited">
            <TabsList>
              <TabsTrigger value="cited">Cited evidence</TabsTrigger>
              {hasGoldEvidence ? <TabsTrigger value="gold">Gold evidence</TabsTrigger> : null}
            </TabsList>
            <TabsContent value="cited" className="pt-2">
              {ex?.chunkId ? (
                <EvidencePage
                  filing={filing}
                  chunkId={ex.chunkId}
                  chunk={chunks[ex.chunkId]}
                  quote={ex.quote}
                  width={660}
                  maxHeight={560}
                  caption="model citation"
                />
              ) : (
                <div className="rounded border border-dashed px-3 py-6 text-center text-[12px] text-muted-foreground">
                  The model did not cite a chunk.
                </div>
              )}
            </TabsContent>
            {hasGoldEvidence ? (
              <TabsContent value="gold" className="pt-2">
                {gold?.quote ? (
                  <blockquote className="mb-2 border-l-2 border-emerald-500 bg-emerald-50/50 py-1.5 pr-2 pl-3 font-serif text-[13px] leading-relaxed">
                    “{formatQuote(gold.quote)}”
                  </blockquote>
                ) : null}
                <EvidencePage
                  filing={filing}
                  chunkId={gold?.chunkId}
                  chunk={gold?.chunkId ? chunks[gold.chunkId] : null}
                  quote={gold?.quote}
                  page={gold?.page}
                  width={660}
                  maxHeight={560}
                  tone="emerald"
                  caption="gold evidence"
                />
              </TabsContent>
            ) : null}
          </Tabs>

          {/* Retrieval */}
          <div>
            <div className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Retrieved context
              <span className="font-normal normal-case tracking-normal">
                {r.retrievedChunkIds?.length ?? 0} chunks
                {goldRetrieved === true ? " · gold chunk retrieved" : goldRetrieved === false ? " · gold chunk NOT retrieved" : ""}
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {(r.retrievedChunkIds ?? []).map((id) => (
                <span
                  key={id}
                  className={cn(
                    "rounded px-1.5 py-px font-mono text-[10.5px] ring-1 ring-inset ring-border",
                    id === ex?.chunkId && "bg-amber-50 ring-amber-400",
                    id === goldChunkId && "bg-emerald-50 ring-emerald-500",
                  )}
                  title={id === goldChunkId ? "gold evidence chunk" : id === ex?.chunkId ? "cited chunk" : undefined}
                >
                  {id}
                </span>
              ))}
            </div>
          </div>

          {/* Accounting */}
          <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
            <div>
              <KV k="Cost">{formatCost(r.costUsd, 6)}</KV>
              <KV k="Latency">{formatMs(r.latencyMs)}</KV>
              <KV k="Tokens in / out">
                {formatInt(r.inputTokens)} / {formatInt(r.outputTokens)}
              </KV>
            </div>
            <div>
              <KV k="Model">{r.model}</KV>
              <KV k="Routed to">{r.routedModel ?? "—"}</KV>
              <KV k="Result id">
                <span className="text-[10px] break-all">{r._id}</span>
              </KV>
            </div>
          </div>

          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground">
              <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]:rotate-90" />
              Raw model output
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-2 max-h-80 overflow-auto rounded bg-neutral-950 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-neutral-100">
                {full ? full.raw || "(empty)" : "Loading…"}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </SheetContent>
    </Sheet>
  );
}
