import Link from "next/link";
import { DbBanner, EmptyState, PIPELINE_COMMANDS } from "@/components/empty-state";
import { RunView } from "@/components/run-view";
import { getDbStatus, getFilings, getResults, getRun, listGold } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function RunPage(props: PageProps<"/runs/[id]">) {
  const { id } = await props.params;
  const status = await getDbStatus();
  if (!status.ok) {
    return (
      <div className="mx-auto w-full max-w-[1600px] space-y-5 px-5 py-6">
        <DbBanner status={status} />
        <EmptyState title="Cannot load this run without the database" commands={PIPELINE_COMMANDS} />
      </div>
    );
  }

  const [run, results, filings, gold] = await Promise.all([getRun(id), getResults(id), getFilings(), listGold()]);
  if (!run) {
    return (
      <div className="mx-auto w-full max-w-[1600px] space-y-5 px-5 py-6">
        <EmptyState title={`Run "${id}" not found`}>
          <Link href="/" className="underline">
            Back to the leaderboard
          </Link>
        </EmptyState>
      </div>
    );
  }

  return (
    <RunView
      key={run._id}
      initialRun={run}
      initialResults={results}
      filings={filings.map((f) => ({
        ticker: f.ticker,
        company: f.company,
        pdfPath: f.pdfPath,
        sourceUrl: f.sourceUrl,
        filingDate: f.filingDate,
        pages: f.pages,
      }))}
      gold={gold.map((g) => ({
        _id: g._id,
        ticker: g.ticker,
        factId: g.factId,
        value: g.value,
        page: g.page,
        quote: g.quote,
        chunkId: g.chunkId,
        status: g.status,
      }))}
    />
  );
}
