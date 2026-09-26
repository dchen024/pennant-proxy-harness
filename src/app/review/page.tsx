import type { Metadata } from "next";
import { DbBanner, EmptyState } from "@/components/empty-state";
import { ReviewTool } from "@/components/review/review-tool";
import { getChunks, getDbStatus, getFilings, listGold } from "@/lib/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Review · Proxy Harness" };

export default async function ReviewPage() {
  const status = await getDbStatus();
  if (!status.ok) {
    return (
      <div className="mx-auto w-full max-w-[1200px] space-y-5 px-5 py-6">
        <DbBanner status={status} />
        <EmptyState
          title="The answer key lives in MongoDB"
          commands={[{ cmd: "pnpm gold:draft", note: "draft the answer key with two models, then verify it here" }]}
        />
      </div>
    );
  }

  const [gold, filings] = await Promise.all([listGold(), getFilings()]);
  if (gold.length === 0) {
    return (
      <div className="mx-auto w-full max-w-[1200px] px-5 py-6">
        <EmptyState
          title="No answer key yet"
          commands={[
            { cmd: "pnpm ingest", note: "parse filings into cited chunks" },
            { cmd: "pnpm gold:draft", note: "two drafting models propose every fact with a citation" },
          ]}
        >
          Once drafts exist, verify each fact here against the highlighted PDF page. Disputed facts (the drafting models
          disagree) come first.
        </EmptyState>
      </div>
    );
  }

  const chunkIds = gold.flatMap((g) => [g.chunkId, ...g.proposals.map((p) => p.chunkId)]).filter((x): x is string => !!x);
  const chunks = await getChunks(chunkIds);

  return (
    <ReviewTool
      initialGold={gold}
      filings={filings.map((f) => ({
        ticker: f.ticker,
        company: f.company,
        pdfPath: f.pdfPath,
        sourceUrl: f.sourceUrl,
        filingDate: f.filingDate,
        pages: f.pages,
      }))}
      chunks={chunks}
    />
  );
}
