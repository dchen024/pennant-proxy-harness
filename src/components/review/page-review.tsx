"use client";

import { useEffect, useMemo } from "react";
import { CheckIcon, Loader2Icon, PencilLineIcon } from "lucide-react";
import { Notice, pageFromChunkId, pageSize, useChunks, type ChunkView, type FilingView } from "@/components/evidence";
import { PdfHighlight } from "@/components/pdf-highlight-lazy";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { COMPANIES } from "@/lib/companies";
import { FACT_BY_ID, FACTS } from "@/lib/facts";
import { formatValue, shortModel } from "@/lib/format";
import { matchQuote } from "@/lib/highlight";
import type { BBox, FactValue, GoldFact } from "@/lib/types";
import { READ_ONLY } from "@/lib/readonly";
import { cn } from "@/lib/utils";

// "By page" review: every fact whose saved citation sits on the same filing page is
// reviewed together, with each citation drawn on that page in its own colour.

type Status = GoldFact["status"];
export type PageFilter = "todo" | "disputed" | "verified" | "all";

/** Six translucent fills with matching outlines (validated for colour-vision deficiency; no amber). */
export const ITEM_COLORS = [
  { solid: "#1d4ed8", fill: "rgba(29, 78, 216, 0.16)" },
  { solid: "#e11d48", fill: "rgba(225, 29, 72, 0.15)" },
  { solid: "#0891b2", fill: "rgba(8, 145, 178, 0.17)" },
  { solid: "#a21caf", fill: "rgba(162, 28, 175, 0.15)" },
  { solid: "#65a30d", fill: "rgba(101, 163, 13, 0.18)" },
  { solid: "#7c3aed", fill: "rgba(124, 58, 237, 0.15)" },
] as const;
export const itemColor = (i: number) => ITEM_COLORS[i % ITEM_COLORS.length];

export interface PageGroup {
  /** `${ticker}:${page}` or `${ticker}:none` */
  key: string;
  ticker: string;
  /** Saved-citation page; null groups the company's facts that have no citation. */
  page: number | null;
  /** Gold ids in fact-catalog order; badge numbers follow this order. */
  ids: string[];
  /** Contained a disputed fact when the page loaded (keeps the order stable). */
  disputed: boolean;
}

export type BatchResult = { state: "saving" } | { state: "done" } | { state: "error"; error: string };

const TICKER_RANK = new Map<string, number>(COMPANIES.map((c, i) => [c.ticker, i]));
const FACT_RANK = new Map<string, number>(FACTS.map((f, i) => [f.id, i]));

/** The page a fact's saved citation points at, or null when it has none. */
export function citationPage(g: GoldFact): number | null {
  return g.page ?? pageFromChunkId(g.chunkId);
}

/** Groups facts by (ticker, saved citation page): disputed groups first, then ticker, then page; no-citation last per company. */
export function buildPageGroups(items: Map<string, GoldFact>, initialStatus: Map<string, Status>): PageGroup[] {
  const byKey = new Map<string, PageGroup>();
  for (const g of items.values()) {
    const page = citationPage(g);
    const key = `${g.ticker}:${page ?? "none"}`;
    let grp = byKey.get(key);
    if (!grp) {
      grp = { key, ticker: g.ticker, page, ids: [], disputed: false };
      byKey.set(key, grp);
    }
    grp.ids.push(g._id);
    if ((initialStatus.get(g._id) ?? g.status) === "disputed") grp.disputed = true;
  }
  const groups = [...byKey.values()];
  for (const grp of groups) {
    grp.ids.sort((a, b) => (FACT_RANK.get(items.get(a)!.factId) ?? 99) - (FACT_RANK.get(items.get(b)!.factId) ?? 99));
  }
  return groups.sort(
    (a, b) =>
      Number(b.disputed) - Number(a.disputed) ||
      (TICKER_RANK.get(a.ticker) ?? 99) - (TICKER_RANK.get(b.ticker) ?? 99) ||
      a.ticker.localeCompare(b.ticker) ||
      (a.page ?? Number.MAX_SAFE_INTEGER) - (b.page ?? Number.MAX_SAFE_INTEGER),
  );
}

export function groupMatches(grp: PageGroup, items: Map<string, GoldFact>, filter: PageFilter): boolean {
  const statuses = grp.ids.map((id) => items.get(id)?.status);
  if (filter === "todo") return statuses.some((s) => s !== "verified");
  if (filter === "disputed") return statuses.some((s) => s === "disputed");
  if (filter === "verified") return statuses.every((s) => s === "verified");
  return true;
}

const shortLabel = (label: string) => label.replace(/\s*\([^)]*\)\s*$/, "");

/** Drafting models (not curators) that disagree about the value. */
export function draftsDisagree(g: GoldFact): boolean {
  if (g.status === "disputed") return true;
  const values = g.proposals.filter((p) => !p.model.startsWith("human/")).map((p) => JSON.stringify(p.value ?? null));
  return new Set(values).size > 1;
}

// ---------------------------------------------------------------------------
// Sidebar list of page groups
// ---------------------------------------------------------------------------

export function PageGroupList({
  groups,
  items,
  selectedKey,
  onSelect,
}: {
  groups: PageGroup[];
  items: Map<string, GoldFact>;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const sections: { label: string; groups: PageGroup[] }[] = [];
  for (const grp of groups) {
    const label = `${grp.disputed ? "Disputed · " : ""}${grp.ticker}`;
    const last = sections[sections.length - 1];
    if (last && last.label === label) last.groups.push(grp);
    else sections.push({ label, groups: [grp] });
  }
  if (groups.length === 0) {
    return <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">Nothing here.</div>;
  }
  return (
    <>
      {sections.map((sec) => (
        <div key={sec.label + sec.groups[0].key} className="pb-1">
          <div className="sticky top-0 z-10 bg-muted/90 px-3 py-1 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase backdrop-blur">
            {sec.label}
          </div>
          {sec.groups.map((grp) => {
            const facts = grp.ids.map((id) => items.get(id)).filter((g): g is GoldFact => !!g);
            const done = facts.filter((g) => g.status === "verified").length;
            const disputedLeft = facts.some((g) => g.status === "disputed");
            const sel = grp.key === selectedKey;
            return (
              <button
                key={grp.key}
                type="button"
                data-group={grp.key}
                onClick={() => onSelect(grp.key)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors",
                  sel ? "bg-foreground text-background" : "hover:bg-muted",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    done === facts.length ? "bg-emerald-500" : disputedLeft ? "bg-red-500" : "bg-amber-400",
                  )}
                />
                <span className="w-14 shrink-0 font-mono text-[11.5px] tabular-nums">
                  {grp.page ? `p. ${grp.page}` : "no cite"}
                </span>
                <span className={cn("truncate text-[11.5px]", sel ? "opacity-80" : "text-muted-foreground")}>
                  {facts.map((g) => shortLabel(FACT_BY_ID[g.factId]?.label ?? g.factId)).join(", ")}
                </span>
                <span className={cn("ml-auto shrink-0 font-mono text-[11px] tabular-nums", sel ? "opacity-80" : "text-muted-foreground")}>
                  {done}/{facts.length}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Middle panel: the group's facts with values, checkboxes and the batch action
// ---------------------------------------------------------------------------

export function ItemBadge({ n, className }: { n: number; className?: string }) {
  const c = itemColor(n - 1);
  return (
    <span
      className={cn(
        "inline-flex size-[18px] shrink-0 items-center justify-center rounded-full font-mono text-[10.5px] font-semibold text-white ring-2 ring-white",
        className,
      )}
      style={{ background: c.solid }}
    >
      {n}
    </span>
  );
}

export function PageGroupPanel({
  group,
  items,
  company,
  drafts,
  onDraft,
  parseDraft,
  isChecked,
  onCheck,
  results,
  running,
  progress,
  message,
  focusedId,
  onFocusItem,
  onVerify,
  onEdit,
}: {
  group: PageGroup | null;
  items: Map<string, GoldFact>;
  company: string | undefined;
  drafts: Record<string, string | boolean | null>;
  onDraft: (id: string, value: string | boolean | null) => void;
  parseDraft: (g: GoldFact) => { value: FactValue } | { error: string };
  isChecked: (g: GoldFact) => boolean;
  onCheck: (id: string, checked: boolean) => void;
  results: Record<string, BatchResult>;
  running: boolean;
  progress: { done: number; total: number };
  message: { text: string; tone: "ok" | "error" } | null;
  focusedId: string | null;
  onFocusItem: (id: string) => void;
  onVerify: () => void;
  onEdit: (id: string) => void;
}) {
  if (!group) {
    return <div className="p-6 text-[13px] text-muted-foreground">No page groups match this filter.</div>;
  }
  const facts = group.ids.map((id) => items.get(id)).filter((g): g is GoldFact => !!g);
  const checkedCount = facts.filter((g) => isChecked(g)).length;
  const unverified = facts.filter((g) => g.status !== "verified").length;

  return (
    <div className="space-y-3 p-4">
      <div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-mono font-semibold text-foreground">{group.ticker}</span>
          <span className="truncate">{company}</span>
          <span className="ml-auto font-mono tabular-nums">{group.page ? `p. ${group.page}` : "no citation"}</span>
        </div>
        <h2 className="mt-1 text-[15px] font-semibold">
          {facts.length} fact{facts.length === 1 ? "" : "s"} {group.page ? `cited on page ${group.page}` : "without a citation"}
        </h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          {READ_ONLY
            ? `${unverified ? `${unverified} not verified yet.` : "All verified."} Click a fact to see its highlight on the page.`
            : `${unverified ? `${unverified} to verify.` : "All verified."} Check the value against its highlight, then verify the checked facts together.`}
        </p>
      </div>

      {message ? (
        <p className={cn("text-[12px]", message.tone === "ok" ? "text-emerald-700" : "text-red-700")} data-batch-message>
          {message.text}
        </p>
      ) : null}

      <div className="space-y-2">
        {facts.map((g, i) => {
          const def = FACT_BY_ID[g.factId];
          const color = itemColor(i);
          const draft = g._id in drafts ? drafts[g._id] : defaultDraft(g);
          const parsed = parseDraft(g);
          const result = results[g._id];
          const checked = isChecked(g);
          return (
            <div
              key={g._id}
              data-page-item={g._id}
              onClick={() => onFocusItem(g._id)}
              className={cn(
                "cursor-pointer rounded-md border bg-background p-2.5 transition-shadow",
                focusedId === g._id && "shadow-[0_0_0_2px_var(--item-color)]",
              )}
              style={{ borderLeft: `3px solid ${color.solid}`, ["--item-color" as string]: color.solid }}
            >
              <div className="flex items-center gap-2">
                <ItemBadge n={i + 1} />
                <span className="truncate text-[12.5px] font-medium" title={def?.description}>
                  {def?.label ?? g.factId}
                </span>
                {g.status === "verified" ? (
                  <span className="shrink-0 rounded bg-emerald-50 px-1 py-px text-[10px] font-medium text-emerald-800 ring-1 ring-emerald-600/25 ring-inset">
                    verified
                  </span>
                ) : g.status === "disputed" ? (
                  <span className="shrink-0 rounded bg-red-50 px-1 py-px text-[10px] font-medium text-red-800 ring-1 ring-red-600/25 ring-inset">
                    disputed
                  </span>
                ) : null}
                {g.evidenceBy === "reviewer" ? (
                  <span className="shrink-0 text-[10px] text-violet-700" title="citation chosen by a reviewer">
                    ✎
                  </span>
                ) : null}
                <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Checkbox
                    checked={checked}
                    disabled={running || READ_ONLY}
                    aria-label={`Verify ${def?.label ?? g.factId}`}
                    data-check={g._id}
                    onCheckedChange={(v) => onCheck(g._id, v === true)}
                  />
                  verify
                </label>
              </div>

              <div className="mt-1.5 flex items-center gap-2">
                {def?.type === "boolean" ? (
                  <div className="inline-flex rounded-md border p-0.5">
                    {[true, false].map((b) => (
                      <button
                        key={String(b)}
                        type="button"
                        data-bool={`${g._id}:${b}`}
                        disabled={READ_ONLY}
                        onClick={() => onDraft(g._id, b)}
                        className={cn(
                          "rounded-[5px] px-2.5 py-0.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed",
                          draft === b ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {b ? "Yes" : "No"}
                      </button>
                    ))}
                  </div>
                ) : (
                  <>
                    <Input
                      value={typeof draft === "string" ? draft : ""}
                      inputMode="decimal"
                      data-value-input={g._id}
                      readOnly={READ_ONLY}
                      onFocus={(e) => {
                        e.currentTarget.select();
                        onFocusItem(g._id);
                      }}
                      onChange={(e) => onDraft(g._id, e.target.value)}
                      className={cn("h-7 w-40 font-mono text-[12.5px] tabular-nums", "error" in parsed && "border-red-400")}
                      placeholder={def?.unit === "usd" ? "e.g. 74.6m" : "number"}
                    />
                    <span className="truncate font-mono text-[11px] text-muted-foreground tabular-nums">
                      {"error" in parsed ? "not a number" : `= ${parsed.value === null ? "—" : formatValue(parsed.value, g.factId)}`}
                    </span>
                  </>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  className="ml-auto"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(g._id);
                  }}
                  data-edit={g._id}
                >
                  <PencilLineIcon />
                  {READ_ONLY ? "Open" : "Edit"}
                </Button>
              </div>

              {draftsDisagree(g) ? (
                <div className="mt-1 truncate text-[11px] text-muted-foreground" title="The drafting models disagree on this value">
                  <span className="text-red-700">Drafts disagree:</span>{" "}
                  {g.proposals.map((p) => `${p.model.startsWith("human/") ? "curated" : shortModel(p.model)} ${formatValue(p.value, g.factId, { compact: true })}`).join(" · ")}
                </div>
              ) : null}
              {!g.chunkId && group.page ? (
                <div className="mt-1 text-[11px] text-amber-800">Saved citation has a page but no passage; nothing is highlighted.</div>
              ) : null}

              {result ? (
                <div
                  className={cn(
                    "mt-1 flex items-center gap-1 text-[11px]",
                    result.state === "error" ? "text-red-700" : result.state === "done" ? "text-emerald-700" : "text-muted-foreground",
                  )}
                  data-result={`${g._id}:${result.state}`}
                >
                  {result.state === "saving" ? <Loader2Icon className="size-3 animate-spin" /> : result.state === "done" ? <CheckIcon className="size-3" /> : null}
                  {result.state === "saving" ? "Saving…" : result.state === "done" ? "Verified" : result.error}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button onClick={onVerify} disabled={READ_ONLY || running || checkedCount === 0} className="flex-1" data-verify-checked>
          {running ? <Loader2Icon className="animate-spin" /> : <CheckIcon />}
          {running ? `Verifying ${progress.done}/${progress.total}…` : `Verify checked (${checkedCount})`}
          <kbd className="ml-1 rounded border border-current/30 px-1 font-mono text-[10px] opacity-70">a</kbd>
        </Button>
      </div>
    </div>
  );
}

export function defaultDraft(g: GoldFact): string | boolean | null {
  const def = FACT_BY_ID[g.factId];
  const v = g.value ?? g.proposals.find((p) => p.value !== null)?.value ?? null;
  if (def?.type === "boolean") return typeof v === "boolean" ? v : null;
  return typeof v === "number" ? String(v) : "";
}

// ---------------------------------------------------------------------------
// Evidence pane: the page once, every fact's citation in its own colour
// ---------------------------------------------------------------------------

const BADGE = 18;

function scrollPaneTo(el: HTMLElement) {
  let p = el.parentElement;
  while (p) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) break;
    p = p.parentElement;
  }
  if (!p) {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }
  const er = el.getBoundingClientRect();
  const pr = p.getBoundingClientRect();
  p.scrollTo({ top: Math.max(0, p.scrollTop + (er.top - pr.top) - p.clientHeight / 2 + er.height / 2), behavior: "smooth" });
}

export function PageGroupEvidence({
  group,
  items,
  filing,
  chunkMap,
  width,
  focusedId,
  focusNonce,
  onFocusItem,
}: {
  group: PageGroup | null;
  items: Map<string, GoldFact>;
  filing: FilingView | undefined;
  chunkMap: Map<string, ChunkView>;
  width: number;
  focusedId: string | null;
  focusNonce: number;
  onFocusItem: (id: string) => void;
}) {
  const facts = useMemo(
    () => (group ? group.ids.map((id) => items.get(id)).filter((g): g is GoldFact => !!g) : []),
    [group, items],
  );
  const fetched = useChunks(facts.map((g) => g.chunkId).filter((id) => id && !chunkMap.has(id)));

  // Boxes per fact; overlapping facts are inset/outset so every outline stays visible.
  const layout = useMemo(() => {
    const placed: { box: BBox }[] = [];
    return facts.map((g, i) => {
      // undefined = still loading, null = no such chunk.
      const chunk = g.chunkId ? (chunkMap.get(g.chunkId) ?? fetched[g.chunkId]) : null;
      const loading = chunk === undefined;
      if (!chunk || chunk.page !== group?.page) return { g, i, boxes: [] as { box: BBox; pad: number }[], matched: false, loading };
      const { boxes, matched } = matchQuote(chunk.lines, g.quote);
      const withPad = boxes.map((b) => {
        const overlaps = placed.filter((q) => q.box[0] < b[2] && b[0] < q.box[2] && q.box[1] < b[3] && b[1] < q.box[3]).length;
        return { box: b, pad: 1.5 + overlaps * 2.5 };
      });
      placed.push(...boxes.map((box) => ({ box })));
      return { g, i, boxes: withPad, matched, loading: false };
    });
  }, [facts, chunkMap, fetched, group?.page]);

  // Scroll the focused fact's first highlight into view.
  useEffect(() => {
    if (!focusedId) return;
    const el = document.querySelector<HTMLElement>(`[data-hl-item="${CSS.escape(focusedId)}"]`);
    if (el) scrollPaneTo(el);
  }, [focusedId, focusNonce]);

  if (!group) return null;
  if (!filing) return <Notice>Filing PDF not available for {group.ticker}.</Notice>;
  if (!group.page) {
    return (
      <Notice>
        These facts have no saved citation, so there is no page to show. Use <span className="font-medium">Edit</span> to open a
        fact in By fact mode and pick its passage with the citation editor.
      </Notice>
    );
  }

  const first = layout.find((l) => l.boxes.length > 0);
  const size = pageSize(filing, group.page);

  return (
    <div className="space-y-2">
      <PdfHighlight
        fileUrl={filing.pdfPath}
        page={group.page}
        pageSize={size}
        width={width}
        highlights={first ? [first.boxes[0].box] : []}
        tone="none"
        scrollKey={group.key}
        caption={`${facts.length} citation${facts.length === 1 ? "" : "s"} on this page`}
        overlay={(scale) => {
          // Badges sit just left of each fact's first box; later badges step aside when they would collide.
          const badges: { x: number; y: number }[] = [];
          const badgeFor = (b: BBox, pad: number) => {
            const left = b[0] * scale - pad;
            const y = ((b[1] + b[3]) / 2) * scale - BADGE / 2;
            const free = (x: number, yy: number) =>
              !badges.some((q) => Math.abs(q.x - x) < BADGE + 2 && Math.abs(q.y - yy) < BADGE + 2);
            // Prefer the margin just left of the box, stepping further left; then step inside the box.
            const spots: { x: number; y: number }[] = [];
            for (let k = 0; k < 6; k++) {
              const x = left - (BADGE + 3) - k * (BADGE + 2);
              if (x >= 1) spots.push({ x, y });
            }
            for (let k = 0; k < 8; k++) spots.push({ x: Math.max(1, left + 2) + k * (BADGE + 2), y });
            const spot = spots.find((c) => free(c.x, c.y)) ?? { x: Math.max(1, left + 2), y: y + BADGE + 2 };
            badges.push(spot);
            return { left: spot.x, top: spot.y };
          };
          return (
            <div className="pointer-events-none absolute inset-0">
              {layout.map(({ g, i, boxes }) =>
                boxes.map(({ box: b, pad }, k) => {
                  const c = itemColor(i);
                  const focused = focusedId === g._id;
                  return (
                    <div
                      key={`${g._id}:${k}`}
                      data-hl-item={k === 0 ? g._id : undefined}
                      className="absolute rounded-[2px] mix-blend-multiply"
                      style={{
                        left: b[0] * scale - pad,
                        top: b[1] * scale - pad,
                        width: Math.max(3, (b[2] - b[0]) * scale + 2 * pad),
                        height: Math.max(3, (b[3] - b[1]) * scale + 2 * pad),
                        background: c.fill,
                        outline: `${focused ? 2.5 : 1.5}px solid ${c.solid}`,
                        outlineOffset: 0,
                      }}
                    />
                  );
                }),
              )}
              {layout.map(({ g, i, boxes }) => {
                if (!boxes.length) return null;
                const pos = badgeFor(boxes[0].box, boxes[0].pad);
                return (
                  <button
                    key={`badge:${g._id}`}
                    type="button"
                    data-badge={g._id}
                    title={FACT_BY_ID[g.factId]?.label ?? g.factId}
                    onClick={() => onFocusItem(g._id)}
                    className="pointer-events-auto absolute"
                    style={{ left: pos.left, top: pos.top }}
                  >
                    <ItemBadge n={i + 1} className="shadow-sm" />
                  </button>
                );
              })}
            </div>
          );
        }}
      />
      {layout.some((l) => l.g.chunkId && !l.loading && l.boxes.length === 0) ? (
        <Notice tone="warn">
          {layout
            .filter((l) => l.g.chunkId && !l.loading && l.boxes.length === 0)
            .map((l) => `#${l.i + 1}`)
            .join(", ")}{" "}
          cite a passage that is not on this page.
        </Notice>
      ) : null}
      {layout.some((l) => l.boxes.length > 0 && !l.matched) ? (
        <Notice tone="warn">
          {layout
            .filter((l) => l.boxes.length > 0 && !l.matched)
            .map((l) => `#${l.i + 1}`)
            .join(", ")}
          : the quote was not found verbatim, so the whole passage is outlined.
        </Notice>
      ) : null}
    </div>
  );
}
