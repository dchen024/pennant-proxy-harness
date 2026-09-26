import type { Metadata } from "next";
import Link from "next/link";
import { collections, getDb } from "@/lib/db";
import { formatPct, modelName } from "@/lib/format";
import { getDbStatus } from "@/lib/queries";
import type { ModelSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Architecture · Proxy Harness" };

const MEMORY_COLLECTIONS = [
  "filings",
  "chunks",
  "retrievals",
  "gold",
  "runs",
  "results",
  "policies",
  "configs",
  "proposals",
  "lessons",
  "judgments",
] as const;

type NodeSpec = { title: string; sub?: string; href?: string; handoff?: string; human?: boolean };

async function loadNumbers() {
  const status = await getDbStatus();
  if (!status.ok) return null;
  const c = await collections();
  const db = await getDb();
  const counts = Object.fromEntries(
    await Promise.all(MEMORY_COLLECTIONS.map(async (name) => [name, await db.collection(name).estimatedDocumentCount()] as const)),
  ) as Record<(typeof MEMORY_COLLECTIONS)[number], number>;
  const verified = await c.gold.countDocuments({ status: "verified" });
  // The latest multi-model comparison run (the demo run), for the best full-pipeline accuracy and the Votes link.
  const runs = await c.runs.find({ status: "done" }, { projection: { label: 1, models: 1, summary: 1, startedAt: 1 } }).sort({ startedAt: -1 }).toArray();
  const demo = runs.find((r) => r.models.length > 2) ?? runs[0];
  const e2e: ModelSummary[] = (demo?.summary ?? []).filter((s) => s.mode === "e2e" && s.graded > 0);
  const bestCorrect = Math.max(...e2e.map((s) => s.correct / s.graded), -1);
  const best = e2e.filter((s) => s.correct / s.graded === bestCorrect);
  const kept = await c.proposals.find({ status: "kept" }).sort({ decidedAt: 1 }).toArray();
  const first = kept[0]?.report?.perModel ?? [];
  const last = kept[kept.length - 1]?.report?.perModel ?? [];
  const gains = first.map((m) => ({ model: m.model, before: m.before, after: last.find((x) => x.model === m.model)?.after ?? m.before, graded: m.graded }));
  return { counts, verified, demoId: demo?._id ?? null, best, bestAcc: bestCorrect, kept: kept.length, gains };
}

export default async function ArchitecturePage() {
  const n = await loadNumbers();
  const votesHref = n?.demoId ? `/runs/${encodeURIComponent(n.demoId)}` : undefined;

  const lanes: { name: string; blurb: string; nodes: NodeSpec[] }[] = [
    {
      name: "Ingestion",
      blurb: "Filings become cited, page-anchored passages",
      nodes: [
        { title: "SEC EDGAR", sub: "DEF 14A proxy statements" },
        { title: "Headless Chrome", sub: "prints each filing to PDF" },
        { title: "PDF", sub: "what the reviewer sees" },
        { title: "pdf.js parser v3", sub: "heading context · symbol-glyph mapping · header/footer removal" },
        { title: "Page-anchored chunks", sub: "every line keeps its box on the page" },
        { title: "Voyage embeddings", sub: "voyage-4 via OpenRouter" },
        {
          title: "MongoDB Atlas",
          sub: "chunks · Vector Search + Atlas Search · parser versions side by side",
          href: "/memory",
          handoff: "↓ read by hybrid retrieval",
        },
      ],
    },
    {
      name: "Human in the loop",
      blurb: "The answer key every model is graded against",
      nodes: [
        { title: "Two drafting models", sub: "propose each fact with a citation; kept out of the comparison" },
        { title: "Human review", sub: "citation editor · by-page review", href: "/review", human: true },
        { title: "Verified answer key", sub: `${n?.verified ?? 70} facts, each with its evidence`, href: "/review", handoff: "↓ grades every answer" },
      ],
    },
    {
      name: "Policy engine",
      blurb: "Written guidelines become deterministic votes",
      nodes: [
        { title: "Written voting policy", sub: "as an asset manager publishes it", href: "/policy" },
        { title: "LLM compiler", sub: "checked against hand-written trees on 2,000 random cases" },
        { title: "Boolean rule trees", sub: "one tree per rule, over the extracted facts", href: "/policy" },
        { title: "Three-valued evaluation", sub: "a missing fact is unknown, never guessed" },
        { title: "FOR · AGAINST · REVIEW", sub: "per ballot item", href: votesHref, handoff: "↓ applied to each model’s facts" },
      ],
    },
    {
      name: "Harness",
      blurb: "The same facts, filings and context for every model",
      nodes: [
        { title: "Models × mode", sub: "via OpenRouter · Full pipeline / Reading only" },
        { title: "Hybrid retrieval", sub: "keyword + vector, reciprocal rank fusion; cached per company × fact" },
        { title: "Extraction", sub: "value + verbatim citation" },
        { title: "Citation checks", sub: "deterministic: quote in chunk, value in quote, right page" },
        { title: "Error attribution", sub: "parse → retrieval → extraction → citation" },
        { title: "Votes & consequential errors", sub: "vote-level", href: votesHref },
        { title: "Leaderboard", sub: "accuracy, votes, cost, latency", href: "/", handoff: "↓ failures feed the judge" },
      ],
    },
    {
      name: "Improvement loop",
      blurb: "Failures turn into small, validated changes",
      nodes: [
        { title: "LLM judge", sub: "diagnoses each wrong answer", href: "/memory" },
        { title: "Improvement agent", sub: "proposes a prompt rule, definition or search query" },
        { title: "Human approval", sub: "approve or reject each proposal", href: "/improve", human: true },
        { title: "Versioned config", sub: "cfg_N on top of the active one", href: "/memory", handoff: "↑ used by the next run" },
        { title: "Validation run", sub: "noise-aware: flips on untouched facts don’t count" },
        { title: "Keep or revert", sub: "keep only if it fixes a target and breaks nothing", href: "/improve" },
      ],
    },
  ];

  const numbers = n
    ? [
        { value: String(n.counts.filings), label: "proxy statements (DEF 14A)" },
        { value: n.counts.chunks.toLocaleString("en-US"), label: "page-anchored passages, two parser versions" },
        { value: String(n.verified), label: "human-verified answers" },
        {
          value: n.best.length ? formatPct(n.bestAcc) : "—",
          label: n.best.length
            ? `best full-pipeline accuracy (${n.best.map((s) => modelName(s.model)).join(" & ")})`
            : "best full-pipeline accuracy",
        },
        {
          value: String(n.kept),
          label: n.gains.length
            ? `changes kept by the loop: ${n.gains.map((g) => `${modelName(g.model)} ${g.before} → ${g.after}/${g.graded}`).join(", ")}`
            : "changes kept by the improvement loop",
        },
      ]
    : [];

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-6 px-5 py-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Architecture</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          How a proxy statement becomes a graded, cited vote, and how the harness gets better with a human in the loop. Boxes
          with an underline open the matching page.
        </p>
      </div>

      {numbers.length ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5" data-numbers>
          {numbers.map((x) => (
            <div key={x.label} className="rounded-lg border bg-card px-4 py-3">
              <div className="font-mono text-xl font-semibold tabular-nums">{x.value}</div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">{x.label}</div>
            </div>
          ))}
        </div>
      ) : null}

      <section className="overflow-x-auto rounded-lg border bg-card p-4" data-diagram aria-label="System diagram">
        <div className="min-w-[1024px] space-y-3">
          {lanes.map((lane) => (
            <div key={lane.name} className="grid grid-cols-[150px_minmax(0,1fr)] items-stretch gap-3" data-lane={lane.name}>
              <div className="flex flex-col justify-center border-r pr-3">
                <div className="text-[12.5px] font-semibold">{lane.name}</div>
                <div className="text-[11px] leading-snug text-muted-foreground">{lane.blurb}</div>
              </div>
              <div className="flex items-stretch">
                {lane.nodes.map((node, i) => (
                  <div key={node.title} className="flex min-w-0 flex-1 items-stretch">
                    {i > 0 ? <Arrow /> : null}
                    <Node node={node} />
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Memory lane */}
          <div className="grid grid-cols-[150px_minmax(0,1fr)] items-stretch gap-3" data-lane="Memory">
            <div className="flex flex-col justify-center border-r pr-3">
              <div className="text-[12.5px] font-semibold">Memory</div>
              <div className="text-[11px] leading-snug text-muted-foreground">MongoDB collections everything reads and writes</div>
            </div>
            <Link href="/memory" className="group flex flex-wrap items-center gap-1.5 rounded-md border border-dashed px-3 py-2.5 hover:border-sky-600/60">
              {MEMORY_COLLECTIONS.map((name) => (
                <span key={name} className="rounded bg-muted px-2 py-0.5 font-mono text-[11.5px]">
                  {name}
                  {n ? <span className="ml-1.5 text-muted-foreground tabular-nums">{n.counts[name].toLocaleString("en-US")}</span> : null}
                </span>
              ))}
              <span className="ml-auto text-[11.5px] text-sky-800 group-hover:underline">What the harness has learned →</span>
            </Link>
          </div>
          <p className="pl-[162px] text-[11.5px] text-muted-foreground">
            LangSmith traces every model call. Arrows run left to right within a lane; ↓ / ↑ notes mark hand-offs between lanes.
          </p>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border bg-card px-4 py-3">
          <h2 className="mb-2 text-[13px] font-semibold">Tech stack</h2>
          <ul className="space-y-1 text-[12.5px]" data-stack>
            {[
              ["App", "Next.js 16 + TypeScript"],
              ["Database", "MongoDB Atlas: Vector Search + Atlas Search"],
              ["Embeddings", "Voyage voyage-4"],
              ["Models via OpenRouter", "Claude Opus 5.5 / Sonnet 5, GPT-6 Sol / Luna, Gemini 3.8 Flash, DeepSeek V4.1 Flash"],
              ["Tracing", "LangSmith"],
              ["PDF", "pdf.js (parsing and the evidence viewer), Puppeteer + Chrome (rendering)"],
              ["Tests", "Vitest"],
            ].map(([k, v]) => (
              <li key={k} className="grid grid-cols-[170px_minmax(0,1fr)] gap-2">
                <span className="text-muted-foreground">{k}</span>
                <span>{v}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg border bg-card px-4 py-3">
          <h2 className="mb-2 text-[13px] font-semibold">Design choices</h2>
          <ul className="list-disc space-y-1 pl-4 text-[12.5px] text-muted-foreground">
            <li>Every number traces to a quote on a page; citations are checked in code, not by a model.</li>
            <li>Every model sees identical retrieved context, so differences are the model’s, not the search’s.</li>
            <li>Votes come from a deterministic policy tree; an error only matters if it changes a vote.</li>
            <li>Humans own the answer key and approve every change; the loop keeps a change only if it helps.</li>
          </ul>
        </div>
      </section>
    </div>
  );
}

function Node({ node }: { node: NodeSpec }) {
  const body = (
    <>
      <div className={cn("text-[12px] leading-tight font-semibold", node.href && "underline decoration-sky-700/40 decoration-dotted underline-offset-2")}>
        {node.title}
        {node.human ? <span className="ml-1 rounded bg-amber-50 px-1 text-[9.5px] font-medium text-amber-900 ring-1 ring-amber-600/25">human</span> : null}
      </div>
      {node.sub ? <div className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">{node.sub}</div> : null}
      {node.handoff ? <div className="mt-1 text-[10.5px] font-medium text-sky-800">{node.handoff}</div> : null}
    </>
  );
  const cls = "min-w-0 flex-1 rounded-md border bg-background px-2.5 py-2";
  return node.href ? (
    <Link href={node.href} className={cn(cls, "transition-colors hover:border-sky-600/60 hover:bg-sky-50/40")} data-node={node.title}>
      {body}
    </Link>
  ) : (
    <div className={cls} data-node={node.title}>
      {body}
    </div>
  );
}

function Arrow() {
  return (
    <svg viewBox="0 0 20 12" className="mx-0.5 w-4 shrink-0 self-center text-neutral-400" aria-hidden>
      <path d="M1 6h15" stroke="currentColor" strokeWidth="1.5" />
      <path d="M13 2l5 4-5 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
