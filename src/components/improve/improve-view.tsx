"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRightIcon, CheckIcon, ExternalLinkIcon, Loader2Icon, RotateCcwIcon, XIcon } from "lucide-react";
import { ReadOnlyBanner } from "@/components/read-only";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { MODEL_PROFILES } from "@/lib/config";
import { FACT_BY_ID } from "@/lib/facts";
import { formatDateTime, modelName, shortModel } from "@/lib/format";
import { READ_ONLY } from "@/lib/readonly";
import type { ConfigDoc, FactId, ProposalDoc, ProposalKind } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { ProposalsPayload, RetrievalPreview, RunBrief } from "./types";
import { WordDiff } from "./word-diff";

const POLL_MS = 3000;
/** Same line-up as the validation run (loop.ts uses MODEL_PROFILES.dev). */
const VALIDATION_MODELS = MODEL_PROFILES.dev ?? [];

const KIND_META: Record<ProposalKind, { label: string; cls: string; what: string }> = {
  prompt_rule: { label: "Prompt rule", cls: "bg-violet-50 text-violet-800 ring-violet-600/20", what: "Adds this rule to the extraction prompt" },
  fact_definition: { label: "Fact definition", cls: "bg-sky-50 text-sky-800 ring-sky-600/20", what: "Fact definition shown to the model" },
  retrieval_query: { label: "Search query", cls: "bg-teal-50 text-teal-800 ring-teal-600/20", what: "Query used to retrieve passages" },
};

const STATUS_META: Record<ProposalDoc["status"], { label: string; cls: string }> = {
  pending: { label: "Pending", cls: "bg-amber-50 text-amber-900 ring-amber-600/30" },
  approved: { label: "Validating…", cls: "bg-sky-50 text-sky-800 ring-sky-600/25" },
  kept: { label: "Kept", cls: "bg-emerald-50 text-emerald-800 ring-emerald-600/25" },
  reverted: { label: "Reverted", cls: "bg-red-50 text-red-800 ring-red-600/20" },
  rejected: { label: "Rejected", cls: "bg-neutral-100 text-neutral-600 ring-neutral-400/30" },
};

const targetLabel = (p: Pick<ProposalDoc, "target">) =>
  p.target === "system" ? "Extraction prompt" : (FACT_BY_ID[p.target as FactId]?.label ?? p.target);

function splitCase(c: string): { ticker: string; factId: string } {
  const i = c.indexOf(":");
  return i < 0 ? { ticker: c, factId: "" } : { ticker: c.slice(0, i), factId: c.slice(i + 1) };
}

/** "openai/gpt-6-luna AAPL:board.nominee_count" -> parts */
function splitOutcome(s: string): { model: string; caseId: string } {
  const i = s.indexOf(" ");
  return i < 0 ? { model: "", caseId: s } : { model: s.slice(0, i), caseId: s.slice(i + 1) };
}

export function ImproveView({ initial }: { initial: ProposalsPayload }) {
  const [data, setData] = useState(initial);
  const [selected, setSelected] = useState<string | null>(
    () => initial.proposals.find((p) => p.status === "pending")?._id ?? initial.proposals[0]?._id ?? null,
  );
  const [confirm, setConfirm] = useState<{ id: string; action: "approve" | "reject" } | null>(null);
  /** Open revert dialog: which kept proposal, and the note typed so far. */
  const [revert, setRevert] = useState<{ id: string; note: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pollError, setPollError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const proposals = data.proposals;
  const validating = proposals.some((p) => p.status === "approved");

  // While a validation run is in flight, refresh every few seconds until it is kept or reverted.
  useEffect(() => {
    if (!validating) return;
    let live = true;
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/proposals", { cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as Partial<ProposalsPayload> & { error?: string };
        if (!res.ok || !body.proposals) throw new Error(body.error || `HTTP ${res.status}`);
        if (!live) return;
        setData({ proposals: body.proposals, activeConfig: body.activeConfig ?? null, runs: body.runs ?? {} });
        setPollError(null);
      } catch (err) {
        if (!live) return;
        setPollError(err instanceof Error ? err.message : String(err));
        setData((d) => ({ ...d })); // schedule another attempt
      }
    }, POLL_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [data, validating]);

  const act = useCallback(async (id: string, action: "approve" | "reject") => {
    if (READ_ONLY) return;
    setBusy(id);
    setErrors((e) => ({ ...e, [id]: "" }));
    try {
      const res = await fetch(`/api/proposals/${encodeURIComponent(id)}/${action}`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as Partial<ProposalsPayload> & { error?: string };
      if (!res.ok || !body.proposals) throw new Error(body.error || `${action === "approve" ? "Approve" : "Reject"} failed (${res.status})`);
      setData({ proposals: body.proposals, activeConfig: body.activeConfig ?? null, runs: body.runs ?? {} });
      setConfirm(null);
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(null);
    }
  }, []);

  /** Human revert of the active kept change; the endpoint answers with the new active config only, so reload. */
  const doRevert = useCallback(async (id: string, note: string) => {
    if (READ_ONLY || !note.trim()) return;
    setBusy(id);
    setErrors((e) => ({ ...e, [id]: "" }));
    try {
      const res = await fetch(`/api/proposals/${encodeURIComponent(id)}/revert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: note.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error || `Revert failed (${res.status})`);
      const list = await fetch("/api/proposals", { cache: "no-store" });
      const next = (await list.json().catch(() => ({}))) as Partial<ProposalsPayload> & { error?: string };
      if (!list.ok || !next.proposals) throw new Error(next.error || `Reverted, but reloading failed (${list.status}); refresh the page.`);
      setData({ proposals: next.proposals, activeConfig: next.activeConfig ?? null, runs: next.runs ?? {} });
      setRevert(null);
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(null);
    }
  }, []);

  const select = useCallback((id: string) => {
    setSelected(id);
    setConfirm(null);
    listRef.current?.querySelector<HTMLElement>(`[data-proposal="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);

  // Keyboard: j/k move, a approve (confirm first), r reject (confirm first), Esc cancels.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (revert) {
        if (e.key === "Escape") {
          e.preventDefault();
          setRevert(null);
        }
        return;
      }
      if (confirm) {
        if (e.key === "Escape") {
          e.preventDefault();
          setConfirm(null);
        }
        return; // Enter on the focused confirm button does the rest
      }
      const key = e.key.toLowerCase();
      const i = selected ? proposals.findIndex((p) => p._id === selected) : -1;
      if (key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = proposals[Math.min(proposals.length - 1, i + 1)];
        if (next) select(next._id);
      } else if (key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        const prev = proposals[Math.max(0, i - 1)];
        if (prev) select(prev._id);
      } else if (!READ_ONLY && (key === "a" || key === "r") && i >= 0 && proposals[i].status === "pending" && busy === null) {
        e.preventDefault();
        setConfirm({ id: proposals[i]._id, action: key === "a" ? "approve" : "reject" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, revert, selected, proposals, select, busy]);

  const counts = proposals.reduce<Record<string, number>>((acc, p) => ((acc[p.status] = (acc[p.status] ?? 0) + 1), acc), {});

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-5 px-5 py-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Improve</h1>
        <p className="mt-1 max-w-[860px] text-[13px] leading-relaxed text-muted-foreground" data-explainer>
          An agent reads graded failures and proposes one change at a time: a prompt rule, a clearer fact definition, or a
          better search query. You approve or reject. Approved changes are checked by a validation run (2 cheap models,
          ~$0.05) and kept only if they fix a targeted case without losing accuracy or votes.
        </p>
      </div>

      {READ_ONLY ? (
        <ReadOnlyBanner className="rounded-md border border-amber-200">
          Read-only demo: proposals can&apos;t be approved, rejected or reverted here.
        </ReadOnlyBanner>
      ) : null}

      <ActiveConfig cfg={data.activeConfig} proposals={proposals} />

      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted-foreground">
        <span data-counts>
          {proposals.length} proposal{proposals.length === 1 ? "" : "s"}
          {Object.entries(counts).length
            ? ` · ${(["pending", "approved", "kept", "reverted", "rejected"] as const)
                .filter((s) => counts[s])
                .map((s) => `${counts[s]} ${STATUS_META[s].label.toLowerCase().replace("…", "")}`)
                .join(" · ")}`
            : ""}
        </span>
        {READ_ONLY ? (
          <span>
            <Kbd>j</Kbd>/<Kbd>k</Kbd> move
          </span>
        ) : (
          <span>
            <Kbd>j</Kbd>/<Kbd>k</Kbd> move · <Kbd>a</Kbd> approve · <Kbd>r</Kbd> reject · <Kbd>Esc</Kbd> cancel
          </span>
        )}
      </div>
      {pollError ? <p className="text-[12px] text-amber-700">Refreshing failed ({pollError}); retrying…</p> : null}

      <div ref={listRef} className="space-y-4">
        {proposals.length === 0 ? (
          <div className="rounded-lg border border-dashed px-6 py-10 text-center text-[13px] text-muted-foreground">
            No proposals yet. The improvement agent writes them after a graded run.
          </div>
        ) : null}
        {proposals.map((p) => (
          <ProposalCard
            key={p._id}
            p={p}
            runs={data.runs}
            selected={selected === p._id}
            confirm={confirm?.id === p._id ? confirm.action : null}
            busy={busy === p._id}
            error={errors[p._id] || null}
            onSelect={() => setSelected(p._id)}
            onAsk={(action) => {
              setSelected(p._id);
              setConfirm({ id: p._id, action });
            }}
            onCancel={() => setConfirm(null)}
            onConfirm={(action) => void act(p._id, action)}
            active={p.status === "kept" && !!p.configId && p.configId === data.activeConfig?._id}
            activeId={data.activeConfig?._id ?? null}
            fallback={data.activeConfig?.parent ?? "the base configuration"}
            revert={revert?.id === p._id ? revert.note : null}
            onRevertOpen={() => {
              setSelected(p._id);
              setConfirm(null);
              setRevert({ id: p._id, note: "" });
            }}
            onRevertNote={(note) => setRevert({ id: p._id, note })}
            onRevertCancel={() => setRevert(null)}
            onRevertConfirm={() => {
              if (revert?.id === p._id) void doRevert(p._id, revert.note);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function ActiveConfig({ cfg, proposals }: { cfg: ConfigDoc | null; proposals: ProposalDoc[] }) {
  return (
    <section className="rounded-lg border bg-card px-4 py-3" data-active-config>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-[13px] font-semibold">Active configuration</h2>
        {cfg ? (
          <span className="text-[12px] text-muted-foreground">
            <span className="font-mono text-foreground">{cfg._id}</span> · built on {cfg.parent ?? "the base configuration"} ·{" "}
            {cfg.systemAppend.length} prompt rule{cfg.systemAppend.length === 1 ? "" : "s"}, {Object.keys(cfg.factDescriptions).length} fact
            definition{Object.keys(cfg.factDescriptions).length === 1 ? "" : "s"}, {Object.keys(cfg.factQueries).length} search quer
            {Object.keys(cfg.factQueries).length === 1 ? "y" : "ies"} changed
          </span>
        ) : (
          <span className="text-[12px] text-muted-foreground">
            Base configuration: no change has been kept yet, so runs use the original prompt, fact definitions and search
            queries.
          </span>
        )}
      </div>
      {cfg?.fromProposals.length ? (
        <ul className="mt-2 space-y-1 text-[12px]">
          {cfg.fromProposals.map((id) => {
            const p = proposals.find((x) => x._id === id);
            return (
              <li key={id} className="flex flex-wrap items-center gap-2">
                <CheckIcon className="size-3.5 text-emerald-600" />
                {p ? <KindBadge kind={p.kind} /> : null}
                <span>{p ? targetLabel(p) : id}</span>
                <a href={`#${id}`} className="font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline">
                  {id}
                </a>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function KindBadge({ kind }: { kind: ProposalKind }) {
  const m = KIND_META[kind];
  return <span className={cn("rounded px-1.5 py-px text-[10.5px] font-medium whitespace-nowrap ring-1 ring-inset", m.cls)}>{m.label}</span>;
}

function StatusBadge({ status, human }: { status: ProposalDoc["status"]; human?: boolean }) {
  const m = STATUS_META[status];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-px text-[11px] font-medium whitespace-nowrap ring-1 ring-inset", m.cls)} data-status={status}>
      {status === "approved" ? <Loader2Icon className="size-3 animate-spin" /> : null}
      {human ? "Reverted by a human" : m.label}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">{title}</div>
      {children}
    </div>
  );
}

function RunLink({ id, runs }: { id: string; runs: Record<string, RunBrief> }) {
  const r = runs[id];
  return (
    <Link href={`/runs/${encodeURIComponent(id)}`} className="inline-flex items-center gap-1 underline decoration-dotted underline-offset-2 hover:text-foreground">
      {r?.label || id}
      <ArrowRightIcon className="size-3" />
    </Link>
  );
}

function CaseChip({ caseId, runId }: { caseId: string; runId: string }) {
  const { ticker, factId } = splitCase(caseId);
  const label = FACT_BY_ID[factId as FactId]?.label ?? factId;
  return (
    <span className="inline-flex items-center overflow-hidden rounded border text-[11.5px]" data-case={caseId}>
      <Link
        href={`/runs/${encodeURIComponent(runId)}`}
        title={`Inspect ${caseId} in the source run's grid`}
        className="inline-flex items-center gap-1.5 px-1.5 py-0.5 hover:bg-muted"
      >
        <span className="font-mono font-semibold">{ticker}</span>
        <span>{label}</span>
      </Link>
      <Link
        href={`/companies/${ticker}`}
        title={`${ticker} company page`}
        className="border-l px-1 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <ExternalLinkIcon className="size-3" />
      </Link>
    </span>
  );
}

function ProposalCard({
  p,
  runs,
  selected,
  confirm,
  busy,
  error,
  onSelect,
  onAsk,
  onCancel,
  onConfirm,
  active,
  activeId,
  fallback,
  revert,
  onRevertOpen,
  onRevertNote,
  onRevertCancel,
  onRevertConfirm,
}: {
  p: ProposalDoc;
  runs: Record<string, RunBrief>;
  selected: boolean;
  confirm: "approve" | "reject" | null;
  busy: boolean;
  error: string | null;
  onSelect: () => void;
  onAsk: (action: "approve" | "reject") => void;
  onCancel: () => void;
  onConfirm: (action: "approve" | "reject") => void;
  /** Kept, and its config is the active one: the only change a human can revert. */
  active: boolean;
  activeId: string | null;
  /** What the active configuration falls back to on revert. */
  fallback: string;
  /** The revert note while the dialog is open on this card, else null. */
  revert: string | null;
  onRevertOpen: () => void;
  onRevertNote: (note: string) => void;
  onRevertCancel: () => void;
  onRevertConfirm: () => void;
}) {
  const kind = KIND_META[p.kind];
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirm) confirmRef.current?.focus();
  }, [confirm]);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const reverting = revert !== null;
  useEffect(() => {
    if (reverting) noteRef.current?.focus();
  }, [reverting]);
  const humanRevert = p.status === "reverted" && !!p.revertNote;
  const vrun = p.validationRunId ? runs[p.validationRunId] : undefined;

  return (
    <article
      id={p._id}
      data-proposal={p._id}
      onClick={onSelect}
      className={cn("scroll-mt-16 rounded-lg border bg-card transition-shadow", selected && "ring-2 ring-foreground/70")}
    >
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <KindBadge kind={p.kind} />
        <span className="text-[13.5px] font-semibold">{targetLabel(p)}</span>
        {p.target !== "system" ? <code className="font-mono text-[11px] text-muted-foreground">{p.target}</code> : null}
        <span className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[10.5px] text-muted-foreground">{p._id}</span>
          <StatusBadge status={p.status} human={humanRevert} />
        </span>
      </header>

      <div className="grid gap-4 px-4 py-3 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          <Section title={p.before === null ? kind.what : `${kind.what}: before → after`}>
            <WordDiff before={p.before} after={p.after} className="rounded-md border bg-muted/20 px-3 py-2" />
            {p.before !== null ? (
              <div className="mt-1 flex gap-3 text-[10.5px] text-muted-foreground">
                <span>
                  <span className="rounded-[2px] bg-red-100 px-1 text-red-900 line-through">removed</span>
                </span>
                <span>
                  <span className="rounded-[2px] bg-emerald-100 px-1 text-emerald-950">added</span>
                </span>
              </div>
            ) : null}
          </Section>
          <Section title="Why">
            <p className="text-[12.5px] leading-relaxed">{p.rationale}</p>
          </Section>
          <Section title="Risk">
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">{p.risk}</p>
          </Section>
        </div>

        <div className="space-y-3">
          <Section title={`Should fix (${p.fixes.length})`}>
            <div className="flex flex-wrap gap-1.5">
              {p.fixes.map((c) => (
                <CaseChip key={c} caseId={c} runId={p.sourceRunId} />
              ))}
            </div>
          </Section>
          {p.kind === "retrieval_query" && p.before !== null ? <SearchPreview proposalId={p._id} /> : null}
          <Section title="Source">
            <p className="text-[12px] text-muted-foreground">
              Proposed by {modelName(p.agentModel)} from failures in <RunLink id={p.sourceRunId} runs={runs} />{" "}
              <span suppressHydrationWarning>· {formatDateTime(p.createdAt)}</span>
            </p>
          </Section>

          {p.status === "approved" ? (
            <div className="space-y-1.5 rounded-md border border-sky-200 bg-sky-50/60 px-3 py-2.5 text-[12px]" data-validating>
              <div className="flex items-center gap-2 font-medium text-sky-900">
                <Loader2Icon className="size-3.5 animate-spin" /> Validating{p.configId ? ` ${p.configId}` : ""}…
              </div>
              {vrun ? (
                <div className="flex items-center gap-2">
                  <Progress value={vrun.progress.total ? (vrun.progress.done / vrun.progress.total) * 100 : 0} className="h-1.5 flex-1" />
                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {vrun.progress.done}/{vrun.progress.total}
                  </span>
                </div>
              ) : null}
              {p.validationRunId ? (
                <Link href={`/runs/${encodeURIComponent(p.validationRunId)}`} className="inline-flex items-center gap-1 text-sky-900 underline underline-offset-2">
                  Watch the validation run live <ArrowRightIcon className="size-3" />
                </Link>
              ) : null}
              <p className="text-[11px] text-muted-foreground">This page refreshes every few seconds until the verdict is in.</p>
            </div>
          ) : null}

          {p.status === "rejected" ? (
            <p className="text-[12px] text-muted-foreground" suppressHydrationWarning>
              Rejected{p.decidedAt ? ` ${formatDateTime(p.decidedAt)}` : ""}. It was not applied.
            </p>
          ) : null}
        </div>
      </div>

      {humanRevert ? (
        <div className="border-t bg-red-50/50 px-4 py-3" data-human-revert>
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-red-800">
            <RotateCcwIcon className="size-4" />
            <span className="font-semibold">Reverted by a human</span>
            {p.decidedAt ? (
              <span className="text-[11.5px] text-muted-foreground" suppressHydrationWarning>
                {formatDateTime(p.decidedAt)}
              </span>
            ) : null}
          </div>
          <p className="mt-1.5 border-l-2 border-red-300 pl-3 text-[13px] leading-relaxed whitespace-pre-line" data-revert-note>
            {p.revertNote}
          </p>
          <p className="mt-1.5 text-[11.5px] text-muted-foreground">
            {p.configId ?? "Its configuration"} is no longer active; runs use {activeId ?? "the base configuration"}. The
            validation below is from before the revert.
          </p>
        </div>
      ) : null}

      {p.report && (p.status === "kept" || p.status === "reverted") ? <Report p={p} runs={runs} earlier={humanRevert} /> : null}

      {active ? (
        <footer className="border-t px-4 py-2.5" onClick={(e) => e.stopPropagation()} data-revert-footer>
          {reverting ? (
            <div className="space-y-2 rounded-md bg-red-50/70 px-3 py-2.5 text-[12.5px]" role="alertdialog" aria-label="Confirm revert" data-revert-dialog>
              <p>
                <span className="font-medium">Revert {p.configId}?</span> The active configuration falls back to {fallback}; the
                next run uses it. No run is started now.
              </p>
              <label htmlFor={`revert-note-${p._id}`} className="block text-[11.5px] font-medium text-muted-foreground">
                Why? A note is required; it is kept with the proposal.
              </label>
              <textarea
                id={`revert-note-${p._id}`}
                ref={noteRef}
                value={revert}
                onChange={(e) => onRevertNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    onRevertCancel();
                  }
                }}
                rows={3}
                maxLength={2000}
                placeholder="What went wrong with this change?"
                className="w-full resize-y rounded-md border bg-background px-2.5 py-1.5 text-[12.5px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-revert-note-input
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="destructive" onClick={onRevertConfirm} disabled={busy || !revert.trim()} data-revert-confirm>
                  {busy ? <Loader2Icon className="animate-spin" /> : <RotateCcwIcon />}
                  Revert {p.configId}
                </Button>
                <Button size="sm" variant="outline" onClick={onRevertCancel} disabled={busy}>
                  Cancel <Kbd>Esc</Kbd>
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={onRevertOpen} disabled={READ_ONLY || busy} data-action="revert">
                <RotateCcwIcon /> Revert…
              </Button>
              <span className="text-[11px] text-muted-foreground">
                {READ_ONLY
                  ? "Reverting is disabled in the read-only demo."
                  : `This is the active change. Reverting falls back to ${fallback}.`}
              </span>
            </div>
          )}
          {error ? (
            <p className="mt-2 text-[12px] text-red-700" data-error>
              {error}
            </p>
          ) : null}
        </footer>
      ) : null}

      {p.status === "pending" ? (
        <footer className="border-t px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
          {confirm ? (
            <div
              className={cn(
                "flex flex-wrap items-center gap-3 rounded-md px-3 py-2 text-[12.5px]",
                confirm === "approve" ? "bg-sky-50 text-sky-950" : "bg-neutral-100",
              )}
              role="alertdialog"
              aria-label={confirm === "approve" ? "Confirm approval" : "Confirm rejection"}
              data-confirm={confirm}
            >
              <span className="min-w-0 flex-1">
                {confirm === "approve" ? (
                  <>
                    <span className="font-medium">Approve and start a validation run (~$0.05)?</span>{" "}
                    {VALIDATION_MODELS.map(shortModel).join(" and ")} re-run the full pipeline on the same filings with this
                    change. It is kept only if it fixes a targeted case without losing accuracy or votes.
                  </>
                ) : (
                  <span className="font-medium">Reject this proposal? It will not be applied.</span>
                )}
              </span>
              <Button ref={confirmRef} size="sm" onClick={() => onConfirm(confirm)} disabled={busy} data-confirm-button={confirm}>
                {busy ? <Loader2Icon className="animate-spin" /> : confirm === "approve" ? <CheckIcon /> : <XIcon />}
                {confirm === "approve" ? "Approve (~$0.05)" : "Reject"}
              </Button>
              <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>
                Cancel <Kbd>Esc</Kbd>
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => onAsk("approve")} disabled={READ_ONLY || busy} data-action="approve">
                <CheckIcon /> Approve… <Kbd>a</Kbd>
              </Button>
              <Button size="sm" variant="outline" onClick={() => onAsk("reject")} disabled={READ_ONLY || busy} data-action="reject">
                <XIcon /> Reject… <Kbd>r</Kbd>
              </Button>
              <span className="text-[11px] text-muted-foreground">
                {READ_ONLY
                  ? "Approving and rejecting are disabled in the read-only demo."
                  : "Approving starts a paid validation run (~$0.05)."}
              </span>
            </div>
          )}
          {error ? (
            <p className="mt-2 text-[12px] text-red-700" data-error>
              {error}
            </p>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}

/** Free preview for search-query changes: where the evidence ranks in keyword search, old vs new query. */
function SearchPreview({ proposalId }: { proposalId: string }) {
  const [state, setState] = useState<{ loading: boolean; data: RetrievalPreview | null; error: string | null }>({
    loading: false,
    data: null,
    error: null,
  });
  const load = async () => {
    setState({ loading: true, data: null, error: null });
    try {
      const res = await fetch(`/api/proposals/${encodeURIComponent(proposalId)}/preview`, { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as Partial<RetrievalPreview> & { error?: string };
      if (!res.ok || !body.cases) throw new Error(body.error || `Preview failed (${res.status})`);
      setState({ loading: false, data: body as RetrievalPreview, error: null });
    } catch (err) {
      setState({ loading: false, data: null, error: err instanceof Error ? err.message : String(err) });
    }
  };
  const rank = (r: number | null, k: number) => (r ? `#${r}` : `not in top ${k}`);
  return (
    <Section title="Search preview">
      {!state.data ? (
        <div className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <Button size="xs" variant="outline" onClick={() => void load()} disabled={state.loading} data-preview-button>
            {state.loading ? <Loader2Icon className="animate-spin" /> : null}
            Preview retrieval (free)
          </Button>
          <span className="text-[11px] text-muted-foreground">Where the evidence ranks with the old vs new query.</span>
        </div>
      ) : (
        <div className="space-y-1.5 text-[12px]" data-preview>
          {state.data.cases.map((c) => {
            const { ticker, factId } = splitCase(c.caseId);
            const better = (c.after.rank ?? 99) < (c.before.rank ?? 99);
            const worse = (c.after.rank ?? 99) > (c.before.rank ?? 99);
            return (
              <div key={c.caseId} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5" data-preview-case={c.caseId}>
                <span>
                  <span className="font-mono font-semibold">{ticker}</span> {FACT_BY_ID[factId as FactId]?.label ?? factId}
                </span>
                <span className="text-[11px] text-muted-foreground">evidence p.{c.evidencePage ?? "?"}</span>
                <span className="font-mono tabular-nums">
                  {rank(c.before.rank, state.data!.k)} → {rank(c.after.rank, state.data!.k)}
                </span>
                <span className={cn("text-[11px] font-medium", better ? "text-emerald-700" : worse ? "text-red-700" : "text-muted-foreground")}>
                  {better ? "better" : worse ? "worse" : "same"}
                </span>
              </div>
            );
          })}
          <p className="text-[11px] text-muted-foreground">
            Keyword (BM25) half of hybrid search, top {state.data.k}, parser {state.data.parserVersion}. The vector half needs
            a paid embedding call, so it isn’t previewed.
          </p>
        </div>
      )}
      {state.error ? <p className="mt-1 text-[12px] text-red-700">{state.error}</p> : null}
    </Section>
  );
}

function Report({ p, runs, earlier }: { p: ProposalDoc; runs: Record<string, RunBrief>; earlier?: boolean }) {
  const r = p.report!;
  const keep = r.verdict === "keep";
  return (
    <div className={cn("border-t px-4 py-3", earlier && "bg-muted/20")} data-report data-earlier={earlier || undefined}>
      {earlier ? (
        <div className="mb-1.5 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">
          Earlier validation, before the human revert
        </div>
      ) : null}
      <div className={cn("mb-2 flex flex-wrap items-center gap-2 text-[12.5px]", keep ? "text-emerald-800" : "text-red-800")}>
        {keep ? <CheckIcon className="size-4" /> : <RotateCcwIcon className="size-4" />}
        <span className="font-semibold">{keep ? "Kept" : "Reverted"}:</span>
        <span className="text-foreground">{r.reason}</span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          vs <RunLink id={r.baselineRunId} runs={runs} />
        </span>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <table className="w-full self-start text-[12px]" data-report-models>
          <thead className="border-b text-[10.5px] tracking-wide text-muted-foreground uppercase">
            <tr>
              <th className="py-1 text-left font-medium">Model</th>
              <th className="py-1 text-left font-medium">Correct</th>
              <th className="py-1 text-left font-medium">Votes</th>
            </tr>
          </thead>
          <tbody>
            {r.perModel.map((m) => {
              const d = m.after - m.before;
              const dv = m.votesAfter - m.votesBefore;
              return (
                <tr key={m.model} className="border-b last:border-b-0">
                  <td className="py-1.5">{modelName(m.model)}</td>
                  <td className="py-1.5 font-mono tabular-nums">
                    {m.before} → {m.after}
                    <span className="text-muted-foreground">/{m.graded}</span>{" "}
                    <Delta n={d} />
                  </td>
                  <td className="py-1.5 font-mono tabular-nums">
                    {m.votesBefore} → {m.votesAfter}
                    <span className="text-muted-foreground">/{m.votesTotal}</span> <Delta n={dv} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 text-[12px]">
            <Outcomes title={`Gained (${r.gained.length})`} items={r.gained} tone="good" runId={r.validationRunId} />
            <Outcomes title={`Lost (${r.lost.length})`} items={r.lost} tone="bad" runId={r.validationRunId} />
          </div>
          {r.noise?.length ? (
            <div className="rounded-md bg-muted/40 px-2.5 py-2 text-[12px] text-muted-foreground" data-noise>
              <div className="mb-1 text-[10.5px] font-medium tracking-wide uppercase">Noise ({r.noise.length})</div>
              <p className="mb-1 text-[11px]">
                Changed on facts this proposal doesn’t touch — run-to-run noise, not counted.
              </p>
              <Outcomes items={r.noise} tone="muted" runId={r.validationRunId} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Delta({ n }: { n: number }) {
  if (n === 0) return <span className="text-[11px] text-muted-foreground">±0</span>;
  return <span className={cn("text-[11px] font-semibold", n > 0 ? "text-emerald-700" : "text-red-700")}>{n > 0 ? `+${n}` : n}</span>;
}

function Outcomes({ title, items, tone, runId }: { title?: string; items: string[]; tone: "good" | "bad" | "muted"; runId: string }) {
  return (
    <div>
      {title ? <div className="mb-1 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">{title}</div> : null}
      {items.length === 0 ? (
        <p className="text-muted-foreground">None</p>
      ) : (
        <ul className="space-y-0.5">
          {items.map((s) => {
            const { model, caseId } = splitOutcome(s);
            const { ticker, factId } = splitCase(caseId);
            return (
              <li key={s} className="flex items-baseline gap-1.5">
                <span className={cn("shrink-0", tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-red-700" : "text-muted-foreground")}>
                  {tone === "good" ? "+" : tone === "bad" ? "−" : "~"}
                </span>
                <span className="min-w-0">
                  <Link href={`/runs/${encodeURIComponent(runId)}`} className="hover:underline">
                    <span className="font-mono font-semibold">{ticker}</span> {FACT_BY_ID[factId as FactId]?.label ?? factId}
                  </Link>{" "}
                  <span className="text-[11px] whitespace-nowrap text-muted-foreground">{shortModel(model)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-4 items-center justify-center rounded border border-current/25 bg-background/60 px-1 font-mono text-[10px] leading-4">
      {children}
    </kbd>
  );
}
