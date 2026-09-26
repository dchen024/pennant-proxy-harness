"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CheckIcon, CornerDownLeftIcon, Loader2Icon, PencilLineIcon, SkipForwardIcon } from "lucide-react";
import { EvidencePage, pageFromChunkId, useChunks, type ChunkView, type FilingView } from "@/components/evidence";
import { CitationEditor, type Citation } from "@/components/review/citation-editor";
import {
  buildPageGroups,
  citationPage,
  groupMatches,
  PageGroupEvidence,
  PageGroupList,
  PageGroupPanel,
  type BatchResult,
  type PageFilter,
} from "@/components/review/page-review";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { COMPANIES } from "@/lib/companies";
import { FACT_BY_ID, FACTS } from "@/lib/facts";
import { formatQuote, formatValue, shortModel } from "@/lib/format";
import type { FactValue, GoldFact, GoldProposal } from "@/lib/types";
import { cn } from "@/lib/utils";

type Status = GoldFact["status"];
type Filter = "todo" | "disputed" | "verified" | "all";
type EvidenceBy = NonNullable<GoldFact["evidenceBy"]>;
/** Which citation the evidence pane shows: the saved one, or proposal i. */
type EvidenceView = "saved" | number;
/** "fact": one fact at a time (the default). "page": every fact cited on one filing page at once. */
type Mode = "fact" | "page";

/** Proposals from this "model" are evidence a human curator chose. */
const CURATED_MODEL = "human/curated-evidence";

const STATUS_RANK: Record<Status, number> = { disputed: 0, proposed: 1, verified: 2 };
const TICKER_RANK = new Map<string, number>(COMPANIES.map((c, i) => [c.ticker, i]));
const FACT_RANK = new Map<string, number>(FACTS.map((f, i) => [f.id, i]));

const STATUS_DOT: Record<Status, string> = {
  disputed: "bg-red-500",
  proposed: "bg-amber-400",
  verified: "bg-emerald-500",
};

const EVIDENCE_BY_LABEL: Record<EvidenceBy, string> = {
  draft: "drafting model",
  curated: "curated",
  reviewer: "reviewer",
};

function sameValue(a: FactValue | undefined, b: FactValue | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a));
  return a === b;
}

/** Parses "74,609,802", "$74.6m", "1.2b", "182.34" into a number. */
function parseNumber(s: string): number | null {
  const t = s.trim().toLowerCase().replace(/[$,\s]/g, "");
  if (!t) return null;
  const m = t.match(/^(-?\d*\.?\d+)([kmb])?$/);
  if (!m) return NaN;
  const mult = m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : m[2] === "b" ? 1e9 : 1;
  return Number(m[1]) * mult;
}

function draftFor(g: GoldFact): string | boolean | null {
  const def = FACT_BY_ID[g.factId];
  const v = g.value ?? g.proposals.find((p) => p.value !== null)?.value ?? null;
  if (def?.type === "boolean") return typeof v === "boolean" ? v : null;
  return typeof v === "number" ? String(v) : "";
}

const proposalLabel = (p: GoldProposal) => (p.model === CURATED_MODEL ? "curated evidence" : shortModel(p.model));

interface EvidenceUpdate {
  chunkId: string;
  quote: string | null;
  page: number | null;
  evidenceBy: EvidenceBy;
}

/**
 * Evidence to store when a fact is verified; null keeps the saved citation.
 * An explicit pick in the evidence pane wins. Otherwise a reviewer's or curator's citation is
 * never replaced by a draft; a curated proposal is preferred; and draft evidence follows the value.
 */
function chooseEvidence(g: GoldFact, value: FactValue, explicit: EvidenceView | undefined): EvidenceUpdate | null {
  const from = (p: GoldProposal): EvidenceUpdate => ({
    chunkId: p.chunkId!,
    quote: p.quote,
    page: pageFromChunkId(p.chunkId),
    evidenceBy: p.model === CURATED_MODEL ? "curated" : "draft",
  });
  if (explicit === "saved") return null;
  if (typeof explicit === "number") {
    const p = g.proposals[explicit];
    if (p?.chunkId && (p.model === CURATED_MODEL || sameValue(p.value, value))) return from(p);
  }
  if (g.evidenceBy === "reviewer" || g.evidenceBy === "curated") return null;
  const curated = g.proposals.find((p) => p.model === CURATED_MODEL && p.chunkId);
  if (curated) return from(curated);
  const saved = g.proposals.find((p) => p.chunkId && p.chunkId === g.chunkId);
  if (saved && sameValue(saved.value, value)) return null;
  const agreeing = g.proposals.find((p) => p.chunkId && sameValue(p.value, value));
  return agreeing ? from(agreeing) : null;
}

export function ReviewTool({
  initialGold,
  filings,
  chunks,
}: {
  initialGold: GoldFact[];
  filings: FilingView[];
  chunks: ChunkView[];
}) {
  const [items, setItems] = useState<Map<string, GoldFact>>(() => new Map(initialGold.map((g) => [g._id, g])));
  // Stable review order, fixed at load: disputed first, then by company and fact.
  const [order] = useState<string[]>(() =>
    [...initialGold]
      .sort(
        (a, b) =>
          STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
          (TICKER_RANK.get(a.ticker) ?? 99) - (TICKER_RANK.get(b.ticker) ?? 99) ||
          a.ticker.localeCompare(b.ticker) ||
          (FACT_RANK.get(a.factId) ?? 99) - (FACT_RANK.get(b.factId) ?? 99),
      )
      .map((g) => g._id),
  );
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(
    () => order.find((id) => initialGold.find((g) => g._id === id)?.status !== "verified") ?? order[0] ?? null,
  );
  const [drafts, setDrafts] = useState<Record<string, string | boolean | null>>({});
  const [evidenceView, setEvidenceView] = useState<Record<string, EvidenceView>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [citeSaving, setCiteSaving] = useState(false);
  const [citeError, setCiteError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // "By page" mode state.
  const [mode, setMode] = useState<Mode>("fact");
  const [pageFilter, setPageFilter] = useState<PageFilter>("todo");
  const [groupKey, setGroupKey] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [batch, setBatch] = useState<{
    running: boolean;
    done: number;
    total: number;
    results: Record<string, BatchResult>;
    message: { text: string; tone: "ok" | "error" } | null;
  }>({ running: false, done: 0, total: 0, results: {}, message: null });
  const [focus, setFocus] = useState<{ id: string | null; nonce: number }>({ id: null, nonce: 0 });

  // Re-sync with the database on mount, so a remount never shows stale statuses.
  useEffect(() => {
    let live = true;
    fetch("/api/gold", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { gold?: GoldFact[] } | null) => {
        if (!live || !d?.gold) return;
        setItems((cur) => {
          const next = new Map(cur);
          for (const g of d.gold!) {
            const mine = cur.get(g._id);
            if (mine && (g.updatedAt ?? "") > (mine.updatedAt ?? "")) next.set(g._id, g);
          }
          return next;
        });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const filingByTicker = useMemo(() => new Map(filings.map((f) => [f.ticker, f])), [filings]);
  const chunkMap = useMemo(() => new Map(chunks.map((c) => [c._id, c])), [chunks]);

  const visible = useMemo(
    () =>
      order.filter((id) => {
        const s = items.get(id)?.status;
        if (filter === "all") return true;
        if (filter === "todo") return s !== "verified";
        return s === filter;
      }),
    [order, items, filter],
  );

  const total = items.size;
  const verified = [...items.values()].filter((g) => g.status === "verified").length;
  const disputedLeft = [...items.values()].filter((g) => g.status === "disputed").length;

  const current = selectedId ? items.get(selectedId) : undefined;
  const def = current ? FACT_BY_ID[current.factId] : undefined;
  const filing = current ? filingByTicker.get(current.ticker) : undefined;
  const draft = current ? (current._id in drafts ? drafts[current._id] : draftFor(current)) : null;

  const proposals = useMemo(() => current?.proposals ?? [], [current]);
  const hasSaved = !!current && (!!current.chunkId || !!current.page);
  const defaultView: EvidenceView = (() => {
    if (!current) return "saved";
    if (hasSaved) return "saved";
    const withChunk = current.proposals.findIndex((p) => p.chunkId);
    return withChunk >= 0 ? withChunk : "saved";
  })();
  const view: EvidenceView = current ? (evidenceView[current._id] ?? defaultView) : "saved";
  const viewedProposal: GoldProposal | undefined = typeof view === "number" ? proposals[view] : undefined;

  // Evidence to show: the saved citation, or the viewed proposal's.
  const evidenceChunkId = view === "saved" ? (current?.chunkId ?? null) : (viewedProposal?.chunkId ?? null);
  const evidenceQuote = view === "saved" ? current?.quote : viewedProposal?.quote;
  const evidencePage = view === "saved" ? current?.page : pageFromChunkId(viewedProposal?.chunkId);
  const fetched = useChunks(
    [evidenceChunkId, current?.chunkId, ...proposals.map((p) => p.chunkId)].filter((id) => id && !chunkMap.has(id)),
  );
  const getChunk = useCallback(
    (id: string | null | undefined): ChunkView | null | undefined => (id ? (chunkMap.get(id) ?? fetched[id]) : null),
    [chunkMap, fetched],
  );
  const evidenceChunk = getChunk(evidenceChunkId);
  const select = useCallback((id: string) => {
    setSelectedId(id);
    setError(null);
    setEditing(false);
    setCiteError(null);
  }, []);

  // Keep the selected list item in view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(selectedId ?? "")}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const move = useCallback(
    (delta: number) => {
      if (visible.length === 0) return;
      const i = selectedId ? visible.indexOf(selectedId) : -1;
      const next = i < 0 ? 0 : Math.min(visible.length - 1, Math.max(0, i + delta));
      select(visible[next]);
      if (document.activeElement === inputRef.current) inputRef.current?.blur();
    },
    [visible, selectedId, select],
  );

  // Next unverified item after `fromId`, preferring what the current filter shows.
  const nextUnverified = useCallback(
    (fromId: string, statuses: Map<string, GoldFact>) => {
      for (const list of [visible, order]) {
        const i = list.indexOf(fromId);
        const rest = i < 0 ? list : [...list.slice(i + 1), ...list.slice(0, i)];
        const hit = rest.find((id) => statuses.get(id)?.status !== "verified");
        if (hit) return hit;
      }
      return null;
    },
    [order, visible],
  );

  const adopt = useCallback(
    (idx: number) => {
      if (!current) return;
      const p = current.proposals[idx];
      if (!p) return;
      setEvidenceView((s) => ({ ...s, [current._id]: idx }));
      const isBool = FACT_BY_ID[current.factId]?.type === "boolean";
      setDrafts((s) => ({
        ...s,
        [current._id]: isBool ? (typeof p.value === "boolean" ? p.value : null) : typeof p.value === "number" ? String(p.value) : "",
      }));
    },
    [current],
  );

  /** The value currently entered for the selected fact. */
  const parsedDraft = useMemo((): { value: FactValue } | { error: string } => {
    if (def?.type === "boolean") return { value: typeof draft === "boolean" ? draft : null };
    const n = parseNumber(typeof draft === "string" ? draft : "");
    if (Number.isNaN(n)) return { error: "Not a number. Examples: 74609802, 74,609,802, $74.6m, 182.34" };
    return { value: n };
  }, [def, draft]);

  const verify = useCallback(async () => {
    if (!current || saving) return;
    if ("error" in parsedDraft) {
      setError(parsedDraft.error);
      return;
    }
    const value = parsedDraft.value;
    const ev = chooseEvidence(current, value, evidenceView[current._id]);
    const body: Record<string, unknown> = { id: current._id, value, status: "verified" };
    if (ev) Object.assign(body, ev);

    const prev = current;
    const optimistic: GoldFact = { ...current, value, status: "verified", ...(ev ?? {}) };
    if (ev && ev.page === null) optimistic.page = current.page;
    const nextItems = new Map(items);
    nextItems.set(current._id, optimistic);
    setItems(nextItems);
    setSaving(current._id);
    setError(null);
    const nextId = nextUnverified(current._id, nextItems);
    if (nextId) select(nextId);
    // Hand the keyboard back to j/k/v for the next item.
    if (document.activeElement === inputRef.current) inputRef.current?.blur();
    setFlash(`${current.ticker} · ${def?.label ?? current.factId} verified as ${formatValue(value, current.factId)}`);

    try {
      const res = await fetch("/api/gold", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { gold?: GoldFact; error?: string };
      if (!res.ok || !data.gold) throw new Error(data.error || `Save failed (${res.status})`);
      setItems((m) => new Map(m).set(data.gold!._id, data.gold!));
    } catch (err) {
      setItems((m) => new Map(m).set(prev._id, prev));
      select(prev._id);
      setFlash(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }, [current, saving, parsedDraft, def, evidenceView, items, nextUnverified, select]);

  /** Saves a reviewer-chosen citation, optionally verifying the entered value in the same write. */
  const saveCitation = useCallback(
    async (citation: Citation, andVerify: boolean) => {
      if (!current || citeSaving) return;
      const body: Record<string, unknown> = {
        id: current._id,
        chunkId: citation.chunkId,
        quote: citation.quote,
        page: citation.page,
        evidenceBy: "reviewer",
      };
      if (andVerify) {
        if ("error" in parsedDraft) {
          setCiteError(parsedDraft.error);
          return;
        }
        body.value = parsedDraft.value;
        body.status = "verified";
      }
      setCiteSaving(true);
      setCiteError(null);
      try {
        const res = await fetch("/api/gold", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => ({}))) as { gold?: GoldFact; error?: string };
        if (!res.ok || !data.gold) throw new Error(data.error || `Save failed (${res.status})`);
        const saved = data.gold;
        const nextItems = new Map(items).set(saved._id, saved);
        setItems(nextItems);
        setEvidenceView((s) => ({ ...s, [saved._id]: "saved" }));
        setEditing(false);
        setError(null);
        const where = `p. ${saved.page ?? citation.page}`;
        if (andVerify) {
          setFlash(`${saved.ticker} · ${def?.label ?? saved.factId} verified as ${formatValue(saved.value, saved.factId)} with your citation (${where})`);
          const nextId = nextUnverified(saved._id, nextItems);
          if (nextId) select(nextId);
        } else {
          setFlash(`Citation saved for ${saved.ticker} · ${def?.label ?? saved.factId} (${where})`);
        }
      } catch (err) {
        setCiteError(err instanceof Error ? err.message : String(err));
      } finally {
        setCiteSaving(false);
      }
    },
    [current, citeSaving, parsedDraft, items, def, nextUnverified, select],
  );

  const skip = useCallback(() => move(1), [move]);

  // Keyboard: j/k move, v or Enter verify, s skip, 1-9 use a proposal, y/n set booleans, e edit value,
  // c edit citation. While the citation editor is open it owns the keyboard (Esc cancels it).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (mode !== "fact" || editing) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (typing) {
        if (e.key === "Enter") {
          e.preventDefault();
          void verify();
        } else if (e.key === "Escape") {
          (t as HTMLInputElement).blur();
        }
        return;
      }
      // Enter on the Verify/Skip buttons keeps its normal meaning; anywhere else it verifies.
      if (t && t.tagName === "BUTTON" && t.dataset.reviewAction && e.key === "Enter") return;
      const key = e.key.toLowerCase();
      if (key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      } else if (key === "v" || e.key === "Enter") {
        e.preventDefault();
        void verify();
      } else if (key === "s") {
        e.preventDefault();
        skip();
      } else if (key === "e") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (key === "c") {
        e.preventDefault();
        if (current && filing) {
          setCiteError(null);
          setEditing(true);
        }
      } else if (/^[1-9]$/.test(key)) {
        adopt(Number(key) - 1);
      } else if ((key === "y" || key === "n") && current && FACT_BY_ID[current.factId]?.type === "boolean") {
        setDrafts((s) => ({ ...s, [current._id]: key === "y" }));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, editing, move, verify, skip, adopt, current, filing]);

  // ---------------------------------------------------------------------------
  // "By page" mode
  // ---------------------------------------------------------------------------

  const initialStatus = useMemo(() => new Map(initialGold.map((g) => [g._id, g.status])), [initialGold]);
  const pageGroups = useMemo(() => buildPageGroups(items, initialStatus), [items, initialStatus]);
  const visibleGroups = useMemo(
    () => pageGroups.filter((grp) => groupMatches(grp, items, pageFilter)),
    [pageGroups, items, pageFilter],
  );
  const selectedGroup = pageGroups.find((grp) => grp.key === groupKey) ?? visibleGroups[0] ?? null;

  const selectGroup = useCallback((key: string) => {
    setGroupKey(key);
    setFocus((f) => ({ id: null, nonce: f.nonce + 1 }));
    setBatch((b) => (b.running ? b : { ...b, results: {}, message: null }));
  }, []);

  const switchMode = useCallback(
    (next: Mode) => {
      if (next === mode) return;
      setEditing(false);
      if (next === "page") {
        // Open the page that holds the fact being reviewed, when it is in the list.
        const g = current;
        const key = g ? `${g.ticker}:${citationPage(g) ?? "none"}` : null;
        if (key && visibleGroups.some((grp) => grp.key === key)) setGroupKey(key);
        else if (!selectedGroup || !visibleGroups.some((grp) => grp.key === selectedGroup.key)) setGroupKey(visibleGroups[0]?.key ?? null);
      }
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      setMode(next);
    },
    [mode, current, visibleGroups, selectedGroup],
  );

  /** "Edit" in By page: open that fact in By fact mode, where the citation editor lives. */
  const editInFactMode = useCallback(
    (id: string) => {
      const s = items.get(id)?.status;
      const shown = filter === "all" || (filter === "todo" ? s !== "verified" : s === filter);
      if (!shown) setFilter("all");
      select(id);
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      setMode("fact");
    },
    [items, filter, select],
  );

  const moveGroup = useCallback(
    (delta: number) => {
      if (visibleGroups.length === 0) return;
      const i = selectedGroup ? visibleGroups.findIndex((grp) => grp.key === selectedGroup.key) : -1;
      const next = i < 0 ? (delta > 0 ? 0 : visibleGroups.length - 1) : Math.min(visibleGroups.length - 1, Math.max(0, i + delta));
      selectGroup(visibleGroups[next].key);
    },
    [visibleGroups, selectedGroup, selectGroup],
  );

  const isChecked = useCallback((g: GoldFact) => checked[g._id] ?? g.status !== "verified", [checked]);

  /** The value shown for a fact in By page (shared drafts with By fact). */
  const parseItemDraft = useCallback(
    (g: GoldFact): { value: FactValue } | { error: string } => {
      const d = g._id in drafts ? drafts[g._id] : draftFor(g);
      if (FACT_BY_ID[g.factId]?.type === "boolean") return { value: typeof d === "boolean" ? d : null };
      const n = parseNumber(typeof d === "string" ? d : "");
      if (Number.isNaN(n)) return { error: "Not a number. Examples: 74609802, 74,609,802, $74.6m, 182.34" };
      return { value: n };
    },
    [drafts],
  );

  /** Verifies every checked fact of the page group, one request each, keeping saved citations as they are. */
  const verifyChecked = useCallback(async () => {
    const grp = selectedGroup;
    if (!grp || batch.running) return;
    const targets = grp.ids.map((id) => items.get(id)).filter((g): g is GoldFact => !!g && isChecked(g));
    if (targets.length === 0) {
      setBatch((b) => ({ ...b, message: { text: "Nothing is checked.", tone: "error" } }));
      return;
    }
    const plans = targets.map((g) => ({ g, parsed: parseItemDraft(g) }));
    const invalid = plans.filter((p) => "error" in p.parsed);
    if (invalid.length > 0) {
      setBatch({
        running: false,
        done: 0,
        total: plans.length,
        results: Object.fromEntries(invalid.map((p) => [p.g._id, { state: "error", error: (p.parsed as { error: string }).error }])),
        message: { text: `Fix ${invalid.length} value${invalid.length === 1 ? "" : "s"} first; nothing was saved.`, tone: "error" },
      });
      return;
    }

    const results: Record<string, BatchResult> = {};
    let statuses = items;
    let ok = 0;
    setBatch({ running: true, done: 0, total: plans.length, results: {}, message: null });
    for (const [n, { g, parsed }] of plans.entries()) {
      results[g._id] = { state: "saving" };
      setBatch((b) => ({ ...b, results: { ...results } }));
      const body: Record<string, unknown> = { id: g._id, value: (parsed as { value: FactValue }).value, status: "verified" };
      // Stamp draft provenance only when it's unset and the saved passage is a drafting model's (never a curator's).
      if (
        !g.evidenceBy &&
        g.chunkId &&
        g.proposals.some((p) => p.model !== CURATED_MODEL && p.chunkId === g.chunkId) &&
        !g.proposals.some((p) => p.model === CURATED_MODEL && p.chunkId === g.chunkId)
      ) {
        body.evidenceBy = "draft";
      }
      try {
        const res = await fetch("/api/gold", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => ({}))) as { gold?: GoldFact; error?: string };
        if (!res.ok || !data.gold) throw new Error(data.error || `Save failed (${res.status})`);
        const saved = data.gold;
        statuses = new Map(statuses).set(saved._id, saved);
        setItems((m) => new Map(m).set(saved._id, saved));
        results[g._id] = { state: "done" };
        ok++;
      } catch (err) {
        results[g._id] = { state: "error", error: err instanceof Error ? err.message : String(err) };
      }
      setBatch((b) => ({ ...b, done: n + 1, results: { ...results } }));
    }

    const where = `${grp.ticker} ${grp.page ? `p. ${grp.page}` : "(no citation)"}`;
    if (ok < plans.length) {
      setBatch((b) => ({
        ...b,
        running: false,
        message: { text: `${ok} verified, ${plans.length - ok} failed on ${where}. See the errors below.`, tone: "error" },
      }));
      return;
    }
    setChecked((c) => {
      const next = { ...c };
      for (const id of grp.ids) delete next[id];
      return next;
    });
    // Advance to the next group (in list order, wrapping) that still has unverified facts.
    const i = pageGroups.findIndex((x) => x.key === grp.key);
    const rest = [...pageGroups.slice(i + 1), ...pageGroups.slice(0, Math.max(0, i))];
    const nextGroup = rest.find((x) => x.ids.some((id) => statuses.get(id)?.status !== "verified"));
    if (nextGroup) {
      setGroupKey(nextGroup.key);
      setFocus((f) => ({ id: null, nonce: f.nonce + 1 }));
    }
    setBatch({
      running: false,
      done: plans.length,
      total: plans.length,
      results: nextGroup ? {} : { ...results },
      message: { text: `✓ ${ok} fact${ok === 1 ? "" : "s"} verified on ${where}.`, tone: "ok" },
    });
  }, [selectedGroup, batch.running, items, isChecked, parseItemDraft, pageGroups]);

  const focusItem = useCallback((id: string) => setFocus((f) => ({ id, nonce: f.nonce + 1 })), []);

  // Keyboard in By page: a verifies the checked facts, j/k move between pages, 1-9 jump to a fact's highlight.
  useEffect(() => {
    if (mode !== "page") return;
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (typing) {
        if (e.key === "Enter" || e.key === "Escape") {
          e.preventDefault();
          (t as HTMLInputElement).blur();
        }
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "a") {
        e.preventDefault();
        void verifyChecked();
      } else if (key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        moveGroup(1);
      } else if (key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        moveGroup(-1);
      } else if (/^[1-9]$/.test(key) && selectedGroup) {
        const id = selectedGroup.ids[Number(key) - 1];
        if (id) focusItem(id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, verifyChecked, moveGroup, focusItem, selectedGroup]);

  // Keep the selected page group in view in the list.
  useEffect(() => {
    if (mode !== "page" || !selectedGroup) return;
    listRef.current?.querySelector<HTMLElement>(`[data-group="${CSS.escape(selectedGroup.key)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [mode, selectedGroup]);

  // PDF width follows the evidence pane.
  const paneRef = useRef<HTMLDivElement>(null);
  const [paneWidth, setPaneWidth] = useState(640);
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setPaneWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pdfWidth = Math.max(420, Math.min(820, paneWidth - 32));

  // Group visible items for the sidebar.
  const groups = useMemo(() => {
    const out: { key: string; label: string; ids: string[] }[] = [];
    for (const id of visible) {
      const g = items.get(id);
      if (!g) continue;
      const initialStatus = initialGold.find((x) => x._id === id)?.status ?? g.status;
      const key = `${initialStatus}:${g.ticker}`;
      const last = out[out.length - 1];
      if (last && last.key === key) last.ids.push(id);
      else
        out.push({
          key,
          label: `${initialStatus === "disputed" ? "Disputed" : initialStatus === "proposed" ? "Agreed" : "Verified"} · ${g.ticker}`,
          ids: [id],
        });
    }
    return out;
  }, [visible, items, initialGold]);

  const parser = current?.chunkId?.includes(":v3:") ? "v3" : "v2";
  // Older docs lack evidenceBy: a saved chunk that is the curated proposal's counts as curated.
  const savedBy: EvidenceBy =
    current?.evidenceBy ??
    (current?.chunkId && current.proposals.some((p) => p.model === CURATED_MODEL && p.chunkId === current.chunkId)
      ? "curated"
      : "draft");

  return (
    <div className="grid h-[calc(100vh-48px)] min-h-0 grid-cols-[280px_400px_minmax(0,1fr)]">
      {/* List */}
      <aside className="flex min-h-0 flex-col border-r bg-muted/20">
        <div className="space-y-2 border-b px-3 py-3">
          <div className="grid grid-cols-2 rounded-md border bg-background p-0.5 text-[11.5px]" role="tablist" aria-label="Review mode">
            {(
              [
                ["fact", "By fact"],
                ["page", "By page"],
              ] as [Mode, string][]
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                data-mode={m}
                onClick={() => switchMode(m)}
                className={cn(
                  "rounded-[5px] px-2 py-1 font-medium transition-colors",
                  mode === m ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-baseline justify-between">
            <h1 className="text-[13px] font-semibold">Answer key review</h1>
            <span className="font-mono text-[12px] tabular-nums">
              {verified}/{total}
            </span>
          </div>
          <Progress value={total ? (verified / total) * 100 : 0} className="h-1.5" />
          <div className="text-[11px] text-muted-foreground">
            {total - verified} left · {disputedLeft} disputed
          </div>
          <div className="flex gap-1">
            {(
              [
                ["all", "All"],
                ["todo", "To do"],
                ["disputed", "Disputed"],
                ["verified", "Verified"],
              ] as [Filter, string][]
            ).map(([f, label]) => (
              <button
                key={f}
                type="button"
                onClick={() => (mode === "page" ? setPageFilter(f) : setFilter(f))}
                className={cn(
                  "rounded px-2 py-0.5 text-[11px] transition-colors",
                  (mode === "page" ? pageFilter : filter) === f
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
          {mode === "page" ? (
            <PageGroupList groups={visibleGroups} items={items} selectedKey={selectedGroup?.key ?? null} onSelect={selectGroup} />
          ) : null}
          {mode === "fact" && groups.map((grp) => (
            <div key={grp.key} className="pb-1">
              <div className="sticky top-0 z-10 bg-muted/90 px-3 py-1 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
                {grp.label}
              </div>
              {grp.ids.map((id) => {
                const g = items.get(id)!;
                const d = FACT_BY_ID[g.factId];
                const sel = id === selectedId;
                return (
                  <button
                    key={id}
                    type="button"
                    data-id={id}
                    onClick={() => select(id)}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors",
                      sel ? "bg-foreground text-background" : "hover:bg-muted",
                    )}
                  >
                    <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[g.status])} />
                    <span className="truncate">{d?.label ?? g.factId}</span>
                    {g.evidenceBy === "reviewer" ? (
                      <span title="citation chosen by a reviewer" className={cn("shrink-0 text-[10px]", sel ? "opacity-80" : "text-violet-700")}>
                        ✎
                      </span>
                    ) : null}
                    <span className={cn("ml-auto shrink-0 font-mono text-[11px] tabular-nums", sel ? "opacity-80" : "text-muted-foreground")}>
                      {g.status === "verified" ? formatValue(g.value, g.factId, { compact: true }) : saving === id ? "…" : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          {mode === "fact" && visible.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">Nothing here.</div>
          ) : null}
        </div>
        {mode === "page" ? (
          <div className="border-t px-3 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
            <Kbd>j</Kbd>/<Kbd>k</Kbd> page · <Kbd>a</Kbd> verify checked · <Kbd>1</Kbd>–<Kbd>9</Kbd> show a fact&apos;s
            highlight · <Kbd>↵</Kbd> leave a value box
          </div>
        ) : (
          <div className="border-t px-3 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
            <Kbd>j</Kbd>/<Kbd>k</Kbd> move · <Kbd>v</Kbd> or <Kbd>↵</Kbd> verify · <Kbd>s</Kbd> skip · <Kbd>1</Kbd>
            <Kbd>2</Kbd> use proposal · <Kbd>e</Kbd> edit value · <Kbd>c</Kbd> edit citation · <Kbd>y</Kbd>/<Kbd>n</Kbd>{" "}
            yes/no
          </div>
        )}
      </aside>

      {/* Decision */}
      <section className="flex min-h-0 flex-col overflow-y-auto border-r">
        {mode === "page" ? (
          <PageGroupPanel
            group={selectedGroup}
            items={items}
            company={selectedGroup ? filingByTicker.get(selectedGroup.ticker)?.company : undefined}
            drafts={drafts}
            onDraft={(id, v) => setDrafts((s) => ({ ...s, [id]: v }))}
            parseDraft={parseItemDraft}
            isChecked={isChecked}
            onCheck={(id, v) => setChecked((c) => ({ ...c, [id]: v }))}
            results={batch.results}
            running={batch.running}
            progress={{ done: batch.done, total: batch.total }}
            message={batch.message}
            focusedId={focus.id}
            onFocusItem={focusItem}
            onVerify={() => void verifyChecked()}
            onEdit={editInFactMode}
          />
        ) : !current ? (
          <div className="p-6 text-[13px] text-muted-foreground">Select a fact to review.</div>
        ) : (
          <div className="space-y-4 p-4">
            <div>
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Link href={`/companies/${current.ticker}`} className="font-mono font-semibold text-foreground hover:underline">
                  {current.ticker}
                </Link>
                <span className="truncate">{filing?.company}</span>
                <span
                  className={cn(
                    "ml-auto rounded px-1.5 py-px text-[10.5px] font-medium ring-1 ring-inset",
                    current.status === "verified" && "bg-emerald-50 text-emerald-800 ring-emerald-600/25",
                    current.status === "disputed" && "bg-red-50 text-red-800 ring-red-600/25",
                    current.status === "proposed" && "bg-amber-50 text-amber-900 ring-amber-600/25",
                  )}
                >
                  {current.status === "proposed" ? "models agree" : current.status}
                </span>
              </div>
              <h2 className="mt-1 text-[15px] font-semibold">{def?.label ?? current.factId}</h2>
              <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{def?.description}</p>
            </div>

            <div className="space-y-2">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Proposals</div>
              <div className={cn("grid gap-2", proposals.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
                {proposals.map((p, i) => {
                  const matches =
                    def?.type === "boolean"
                      ? sameValue(p.value, draft as boolean | null)
                      : sameValue(p.value, parseNumber(String(draft ?? "")));
                  const page = pageFromChunkId(p.chunkId);
                  const curated = p.model === CURATED_MODEL;
                  return (
                    <button
                      key={`${p.model}-${i}`}
                      type="button"
                      onClick={() => adopt(i)}
                      className={cn(
                        "flex flex-col gap-1 rounded-md border p-2.5 text-left transition-colors hover:bg-muted/50",
                        curated && "bg-emerald-50/40",
                        view === i && "border-amber-400 ring-1 ring-amber-400",
                      )}
                    >
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Kbd>{i + 1}</Kbd>
                        <span className={cn("truncate", curated ? "font-medium text-emerald-800" : "font-mono")}>{proposalLabel(p)}</span>
                        {matches ? <CheckIcon className="ml-auto size-3.5 text-emerald-600" /> : null}
                      </div>
                      <div className="font-mono text-[15px] font-semibold tabular-nums">{formatValue(p.value, current.factId)}</div>
                      <div className="line-clamp-4 font-serif text-[11.5px] leading-snug text-muted-foreground" title={p.quote ?? undefined}>
                        {p.quote ? `“${formatQuote(p.quote)}”` : "no quote"}
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground">{page ? `p. ${page}` : "no citation"}</div>
                    </button>
                  );
                })}
                {proposals.length === 0 ? (
                  <div className="rounded-md border border-dashed p-3 text-[12px] text-muted-foreground">No drafts for this fact.</div>
                ) : null}
              </div>
            </div>

            <div className="space-y-2 rounded-md border bg-muted/30 p-3">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Verified value</div>
              {def?.type === "boolean" ? (
                <div className="flex gap-2">
                  {[true, false].map((b) => (
                    <button
                      key={String(b)}
                      type="button"
                      onClick={() => setDrafts((s) => ({ ...s, [current._id]: b }))}
                      className={cn(
                        "flex-1 rounded-md border px-3 py-2 text-[13px] font-medium transition-colors",
                        draft === b ? "border-foreground bg-foreground text-background" : "bg-background hover:bg-muted",
                      )}
                    >
                      {b ? "Yes" : "No"} <span className="ml-1 text-[10px] opacity-60">({b ? "y" : "n"})</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-1">
                  <Input
                    ref={inputRef}
                    inputMode="decimal"
                    value={typeof draft === "string" ? draft : ""}
                    onChange={(e) => setDrafts((s) => ({ ...s, [current._id]: e.target.value }))}
                    className="h-9 font-mono text-[14px] tabular-nums"
                    placeholder={def?.unit === "usd" ? "e.g. 74609802 or 74.6m" : "number"}
                  />
                  <div className="font-mono text-[11px] text-muted-foreground tabular-nums">
                    ={" "}
                    {"error" in parsedDraft
                      ? "not a number"
                      : parsedDraft.value === null
                        ? "—"
                        : formatValue(parsedDraft.value, current.factId)}
                  </div>
                </div>
              )}
              <div className="flex gap-2 pt-1">
                <Button
                  data-review-action="verify"
                  onClick={() => void verify()}
                  disabled={!!saving || editing}
                  className="flex-1"
                  title={editing ? "Save or cancel the citation edit first" : undefined}
                >
                  {saving === current._id ? <Loader2Icon className="animate-spin" /> : <CheckIcon />}
                  Verify
                  <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] opacity-70">
                    v / <CornerDownLeftIcon className="size-3" />
                  </span>
                </Button>
                <Button data-review-action="skip" variant="outline" onClick={skip} disabled={editing}>
                  <SkipForwardIcon />
                  Skip <span className="text-[10px] opacity-60">s</span>
                </Button>
              </div>
              {error ? <p className="text-[12px] text-red-700">{error}</p> : null}
              {flash && !error ? <p className="truncate text-[11px] text-emerald-700" title={flash}>✓ {flash}</p> : null}
            </div>

            <div className="space-y-1 text-[11px] text-muted-foreground">
              <div>
                Saved citation:{" "}
                {current.chunkId ? (
                  <>
                    <span className="font-mono text-foreground">{current.chunkId}</span>
                    {current.page ? ` · p. ${current.page}` : ""} · chosen by{" "}
                    <span className={cn("font-medium", savedBy === "reviewer" ? "text-violet-700" : savedBy === "curated" ? "text-emerald-700" : "text-foreground")}>
                      {EVIDENCE_BY_LABEL[savedBy]}
                    </span>
                  </>
                ) : (
                  "none"
                )}
              </div>
              {current.status === "verified" ? (
                <div>
                  Verified {current.updatedAt ? new Date(current.updatedAt).toLocaleTimeString() : ""}. Change the value
                  and verify again to correct it.
                </div>
              ) : null}
            </div>
          </div>
        )}
      </section>

      {/* Evidence */}
      <section ref={paneRef} className="min-h-0 overflow-y-auto bg-neutral-100/70 p-4">
        {mode === "page" ? (
          selectedGroup ? (
            <div className="mx-auto" style={{ width: pdfWidth }}>
              <PageGroupEvidence
                group={selectedGroup}
                items={items}
                filing={filingByTicker.get(selectedGroup.ticker)}
                chunkMap={chunkMap}
                width={pdfWidth}
                focusedId={focus.id}
                focusNonce={focus.nonce}
                onFocusItem={focusItem}
              />
            </div>
          ) : null
        ) : current && filing && editing ? (
          <div className="mx-auto" style={{ width: pdfWidth }}>
            <CitationEditor
              key={current._id}
              ticker={current.ticker}
              filing={filing}
              parser={parser}
              width={pdfWidth}
              initial={{ chunkId: evidenceChunkId, quote: evidenceQuote ?? null, page: evidenceChunk?.page ?? evidencePage ?? null }}
              initialLabel={viewedProposal ? `${proposalLabel(viewedProposal)} citation` : "saved citation"}
              saving={citeSaving}
              error={citeError}
              canVerify={!("error" in parsedDraft)}
              verifyLabel={
                "error" in parsedDraft
                  ? "(fix the value first)"
                  : `as ${parsedDraft.value === null ? "not disclosed" : formatValue(parsedDraft.value, current.factId)}`
              }
              onCancel={() => {
                setEditing(false);
                setCiteError(null);
              }}
              onSave={(c, andVerify) => void saveCitation(c, andVerify)}
            />
          </div>
        ) : current ? (
          <div className="mx-auto" style={{ width: pdfWidth }}>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span>Showing</span>
              {hasSaved ? (
                <button
                  type="button"
                  onClick={() => setEvidenceView((s) => ({ ...s, [current._id]: "saved" }))}
                  className={cn(
                    "rounded border px-1.5 py-0.5",
                    view === "saved" ? "border-amber-400 bg-amber-50 text-amber-900" : "bg-background hover:text-foreground",
                  )}
                >
                  saved citation{current.page ? ` p.${current.page}` : ""} · {EVIDENCE_BY_LABEL[savedBy]}
                </button>
              ) : null}
              {proposals.map((p, i) =>
                p.chunkId ? (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setEvidenceView((s) => ({ ...s, [current._id]: i }))}
                    className={cn(
                      "rounded border px-1.5 py-0.5 font-mono",
                      view === i ? "border-amber-400 bg-amber-50 text-amber-900" : "bg-background hover:text-foreground",
                    )}
                  >
                    {proposalLabel(p)} p.{pageFromChunkId(p.chunkId) ?? "?"}
                  </button>
                ) : null,
              )}
              <Button
                variant="outline"
                size="xs"
                className="ml-auto"
                onClick={() => {
                  setCiteError(null);
                  setEditing(true);
                }}
                disabled={!filing}
              >
                <PencilLineIcon />
                Edit citation <Kbd>c</Kbd>
              </Button>
            </div>
            <EvidencePage
              filing={filing}
              chunkId={evidenceChunkId}
              chunk={evidenceChunk}
              quote={evidenceQuote}
              page={evidencePage ?? current.page}
              width={pdfWidth}
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-4 items-center justify-center rounded border bg-background px-1 font-mono text-[10px] leading-4 text-foreground">
      {children}
    </kbd>
  );
}
