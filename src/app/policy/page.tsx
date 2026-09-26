import type { Metadata } from "next";
import Link from "next/link";
import { DbBanner } from "@/components/empty-state";
import { RuleCard, VOTE_ITEM_LABEL, VoteBadge } from "@/components/policy-view";
import { COMPANIES } from "@/lib/companies";
import { evaluatePolicy, VOTE_ITEMS } from "@/lib/policy/evaluate";
import { GOLD_POLICY, POLICY_TEXT } from "@/lib/policy/policy";
import { getDbStatus, listGold } from "@/lib/queries";
import type { FactMap, GoldFact } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Policy · Proxy Harness" };

function factMap(gold: GoldFact[]): FactMap {
  const m: FactMap = {};
  for (const g of gold) if (g.status !== "disputed") m[g.factId] = g.value;
  return m;
}

export default async function PolicyPage() {
  const status = await getDbStatus();
  const gold = status.ok ? await listGold() : [];
  const byTicker = new Map<string, GoldFact[]>();
  for (const g of gold) byTicker.set(g.ticker, [...(byTicker.get(g.ticker) ?? []), g]);
  const tickers = [
    ...COMPANIES.map((c) => c.ticker).filter((t) => byTicker.has(t)),
    ...[...byTicker.keys()].filter((t) => !COMPANIES.some((c) => c.ticker === t)),
  ];

  const paragraphs = POLICY_TEXT.split(/\n\s*\n/);

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-5 px-5 py-6">
      <DbBanner status={status} />
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Voting policy</h1>
        <p className="text-[13px] text-muted-foreground">
          The investor&apos;s written guidelines, compiled into deterministic rule trees over the 14 extracted facts.
          Any vote is reproducible from the facts, and every fact traces to a quote in the filing.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <section className="rounded-lg border bg-card">
          <div className="border-b px-4 py-2.5">
            <h2 className="text-[13px] font-semibold">As written</h2>
          </div>
          <div className="space-y-3 px-5 py-4 font-serif text-[13.5px] leading-relaxed">
            {paragraphs.map((p, i) => (
              <p key={i} className={i === 0 ? "font-sans text-[13px] font-semibold" : ""}>
                {p}
              </p>
            ))}
          </div>
        </section>

        <section className="rounded-lg border bg-card">
          <div className="border-b px-4 py-2.5">
            <h2 className="text-[13px] font-semibold">As executed</h2>
            <p className="text-[11px] text-muted-foreground">
              {GOLD_POLICY.name}. Items default to FOR; any fired rule makes the item AGAINST; a rule that cannot be
              evaluated (missing fact) sends the item to REVIEW.
            </p>
          </div>
          <div className="space-y-3 p-4">
            {GOLD_POLICY.rules.map((r) => (
              <RuleCard key={r.id} rule={r} />
            ))}
          </div>
        </section>
      </div>

      <section className="rounded-lg border bg-card">
        <div className="border-b px-4 py-2.5">
          <h2 className="text-[13px] font-semibold">Votes from the answer key</h2>
          <p className="text-[11px] text-muted-foreground">
            The reference votes every model is scored against: the policy applied to the answer-key facts (disputed facts
            are treated as unknown until verified).
          </p>
        </div>
        {tickers.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-muted-foreground">
            No answer key yet. Run <code className="font-mono">pnpm gold:draft</code>, then verify facts in Review.
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Company</th>
                {VOTE_ITEMS.map((item) => (
                  <th key={item} className="px-4 py-2 text-left font-medium">
                    {VOTE_ITEM_LABEL[item]}
                  </th>
                ))}
                <th className="px-4 py-2 text-left font-medium">Answer key</th>
              </tr>
            </thead>
            <tbody>
              {tickers.map((t) => {
                const facts = byTicker.get(t) ?? [];
                const ev = evaluatePolicy(GOLD_POLICY, factMap(facts));
                const verified = facts.filter((f) => f.status === "verified").length;
                return (
                  <tr key={t} className="border-b last:border-b-0">
                    <td className="px-4 py-2">
                      <Link href={`/companies/${t}`} className="font-mono font-semibold hover:underline">
                        {t}
                      </Link>
                      <span className="ml-2 text-[12px] text-muted-foreground">
                        {COMPANIES.find((c) => c.ticker === t)?.company}
                      </span>
                    </td>
                    {ev.decisions.map((d) => (
                      <td key={d.item} className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <VoteBadge vote={d.vote} />
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {[...d.firedRules, ...d.unknownRules.map((r) => `${r}?`)].join(" ")}
                          </span>
                        </div>
                      </td>
                    ))}
                    <td className="px-4 py-2 font-mono text-[12px] tabular-nums text-muted-foreground">
                      {verified}/{facts.length} verified
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
