import { AutoRefresh } from "@/components/auto-refresh";
import { DbBanner, EmptyState, PIPELINE_COMMANDS } from "@/components/empty-state";
import { LeaderboardView } from "@/components/leaderboard/leaderboard-view";
import { NewRunPanel } from "@/components/new-run-panel";
import { RunPicker } from "@/components/run-picker";
import { RunHeader } from "@/components/run-summary";
import { sortSummaries, summarize } from "@/components/stats";
import { getDbStatus, getDefaultRun, getResults, getRun, listRuns } from "@/lib/queries";
import type { ModelSummary } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function LeaderboardPage(props: PageProps<"/">) {
  const sp = await props.searchParams;
  const requested = typeof sp.run === "string" ? sp.run : undefined;

  const status = await getDbStatus();
  const runs = status.ok ? await listRuns() : [];
  const run = requested
    ? (runs.find((r) => r._id === requested) ?? (status.ok ? await getRun(requested) : null))
    : await getDefaultRun(runs);

  let rows: ModelSummary[] = [];
  let provisional = false;
  if (run) {
    if (run.summary && run.summary.length > 0) {
      rows = sortSummaries(run.summary);
    } else {
      rows = summarize(await getResults(run._id));
      provisional = true;
    }
  }
  const filings = run?.tickers?.length ?? 0;

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-5 py-6">
      <DbBanner status={status} />
      <AutoRefresh enabled={run?.status === "running"} />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Leaderboard</h1>
          <p className="text-[13px] text-muted-foreground">
            Which model can apply the voting policy to a proxy statement: accuracy against a human-verified answer key,
            errors that flip votes, citation integrity and cost.
          </p>
        </div>
        <RunPicker
          runs={runs.map((r) => ({
            _id: r._id,
            label: r.label,
            status: r.status,
            startedAt: r.startedAt,
            models: r.models,
            modes: r.modes,
          }))}
          value={run?._id}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 min-[1400px]:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          {!run ? (
            <EmptyState
              title={requested ? `Run "${requested}" not found` : "No runs yet"}
              commands={PIPELINE_COMMANDS}
            >
              Runs appear here once the harness has written results to MongoDB. Start one from the panel on the right, or
              run the pipeline from the terminal:
            </EmptyState>
          ) : (
            <>
              <RunHeader run={run} />
              <LeaderboardView
                key={run._id}
                rows={rows}
                run={{ models: run.models.length, modes: run.modes, filings, factsPerFiling: run.factIds.length }}
                provisional={provisional}
                notes={<MethodNotes />}
              />
            </>
          )}
        </div>

        <aside className="space-y-5">
          <NewRunPanel />
        </aside>
      </div>
    </div>
  );
}

function MethodNotes() {
  const items = [
    ["Answer key", "Drafted by two models outside the comparison, then verified by a human with the PDF open."],
    ["Traceability", "Every extracted value carries a chunk id and verbatim quote; code checks the quote is in the chunk and the number is in the quote."],
    ["Attribution", "Each wrong fact is blamed on the first stage that failed: parse → retrieval → extraction → citation."],
    ["Consequence", "A deterministic policy tree turns facts into votes. An error is consequential only if it flips a vote."],
    [
      "Two modes, one run",
      "Full pipeline: the model sees the passages our search retrieved. Reading only: it is handed the human-verified evidence passage, so its errors are about reading, not search.",
    ],
  ];
  return (
    <section className="rounded-lg border bg-card">
      <div className="border-b px-4 py-2.5">
        <h2 className="text-[13px] font-semibold">How to read this</h2>
      </div>
      <dl className="space-y-2.5 px-4 py-3 text-[12px]">
        {items.map(([k, v]) => (
          <div key={k}>
            <dt className="font-medium">{k}</dt>
            <dd className="text-muted-foreground">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
