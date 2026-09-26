import "./_env";
import { RETRIEVAL_K } from "@/lib/config";
import { closeDb, collections, getDb } from "@/lib/db";
import { FACTS } from "@/lib/facts";
import { evidenceIn, normalize, textContains } from "@/lib/harness/checks";
import { hybridSearch, retrieve } from "@/lib/harness/retrieve";
import type { Chunk, FactId, GoldFact } from "@/lib/types";

// Self-improvement loop for retrieval, evaluated leave-one-company-out:
//   learn  : from the verified evidence of 4 companies, find terms the fact's search query lacks
//            (terms shared by at least 2 companies' evidence, weighted by how rare they are in the corpus)
//   store  : save them as lessons in MongoDB, with provenance (companies learned from, failures that motivated them)
//   apply  : search the 5th, held-out company with query + lessons
//   measure: recall@k vs. the same search without lessons, on filings the lessons never saw
// Usage: pnpm learn:retrieval        (a few cents at most: only query embeddings are called)

const PARSER = "v3";
const TICKERS = ["AAPL", "MSFT", "GOOGL", "META", "JPM"];
const MAX_TERMS = 6;
const STOP = new Set(
  ("the and for with that this from our are was were has have had its their which will been such other than " +
    "all any each may not but also into under over more most per year years fiscal company companies board " +
    "table following page proxy statement shares share stock including included".split(" ")),
);

export interface Lesson {
  _id: string; // `${factId}:${scope}`
  factId: FactId;
  scope: string; // "heldout-<TICKER>" for evaluation folds, "all" for the lesson future runs use
  terms: string[];
  learnedFrom: string[];
  motivatedBy: string[]; // training (ticker:fact) whose evidence the base search missed
  parserVersion: string;
  createdAt: string;
}

const words = (text: string) => (normalize(text).match(/[a-z][a-z-]{2,}/g) ?? []).filter((w) => !STOP.has(w));

async function main() {
  const c = await collections();
  const lessons = (await getDb()).collection<Lesson>("lessons");
  const gold = (await c.gold.find({ status: "verified" }).toArray()).filter((g) => g.value !== null);
  const chunks = await c.chunks.find({ parserVersion: PARSER }, { projection: { embedding: 0 } }).toArray();
  const byId = new Map(chunks.map((ch) => [ch._id, ch]));
  const byTicker = new Map(TICKERS.map((t) => [t, chunks.filter((ch) => ch.ticker === t)]));

  // The gold evidence was chosen on v2 chunks; find the same passage among v3 chunks.
  const evidenceChunk = (g: GoldFact): Chunk | undefined => {
    const doc = byTicker.get(g.ticker) ?? [];
    if (g.quote) {
      const hit = doc.find((ch) => ch.page === g.page && textContains(ch.text, g.quote!)) ?? doc.find((ch) => textContains(ch.text, g.quote!));
      if (hit) return hit;
    }
    return g.chunkId ? byId.get(g.chunkId.replace(/^([A-Z]+):p/, `$1:${PARSER}:p`)) : undefined;
  };

  // Document frequency per ticker corpus, for an idf that only uses training filings.
  const chunkWords = new Map(chunks.map((ch) => [ch._id, new Set(words(`${ch.context ?? ""}\n${ch.text}`))]));
  const idfFor = (train: string[]) => {
    const pool = chunks.filter((ch) => train.includes(ch.ticker));
    const n = new Map<string, number>();
    for (const ch of pool) for (const w of chunkWords.get(ch._id)!) n.set(w, (n.get(w) ?? 0) + 1);
    return (w: string) => Math.log(pool.length / (1 + (n.get(w) ?? 0)));
  };

  const learn = async (train: string[], factId: FactId, scope: string) => {
    const fact = FACTS.find((f) => f.id === factId)!;
    const idf = idfFor(train);
    const df = new Map<string, number>();
    const motivatedBy: string[] = [];
    for (const g of gold.filter((x) => x.factId === factId && train.includes(x.ticker))) {
      const ch = evidenceChunk(g);
      if (!ch) continue;
      for (const w of chunkWords.get(ch._id)!) df.set(w, (df.get(w) ?? 0) + 1);
      const base = await retrieve(g.ticker, factId, RETRIEVAL_K, PARSER, "hybrid");
      if (!evidenceIn(base, g, fact)) motivatedBy.push(`${g.ticker}:${factId}`);
    }
    const inQuery = new Set(words(fact.query));
    const terms = [...df.entries()]
      .filter(([w, n]) => n >= 2 && !inQuery.has(w))
      .map(([w, n]) => ({ w, score: (n / train.length) * idf(w) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_TERMS)
      .map((x) => x.w);
    const lesson: Lesson = {
      _id: `${factId}:${scope}`,
      factId,
      scope,
      terms,
      learnedFrom: train,
      motivatedBy,
      parserVersion: PARSER,
      createdAt: new Date().toISOString(),
    };
    await lessons.replaceOne({ _id: lesson._id }, lesson, { upsert: true });
    return lesson;
  };

  const searchWith = async (ticker: string, factId: FactId, terms: string[]) => {
    const fact = FACTS.find((f) => f.id === factId)!;
    const hits = await hybridSearch(ticker, terms.length ? `${fact.query} ${terms.join(" ")}` : fact.query, RETRIEVAL_K, PARSER);
    return hits.map((h) => byId.get(h._id)).filter((ch): ch is Chunk => Boolean(ch));
  };

  // Gate: adopt a lesson only if it loses none of the evidence plain search already finds in the
  // training companies ("do no harm on what we know"). Then measure it on the held-out company.
  const gate = async (train: string[], factId: FactId, terms: string[]) => {
    const fact = FACTS.find((f) => f.id === factId)!;
    let lost = 0;
    let gained = 0;
    for (const g of gold.filter((x) => x.factId === factId && train.includes(x.ticker))) {
      const before = evidenceIn(await retrieve(g.ticker, factId, RETRIEVAL_K, PARSER, "hybrid"), g, fact);
      const after = evidenceIn(await searchWith(g.ticker, factId, terms), g, fact);
      if (before && !after) lost++;
      if (!before && after) gained++;
    }
    return { adopt: terms.length > 0 && lost === 0, lost, gained };
  };

  const rows: { fact: string; ticker: string; base: boolean; naive: boolean; gated: boolean; adopted: boolean }[] = [];
  for (const held of TICKERS) {
    const train = TICKERS.filter((t) => t !== held);
    for (const fact of FACTS) {
      const g = gold.find((x) => x.ticker === held && x.factId === fact.id);
      const lesson = await learn(train, fact.id, `heldout-${held}`);
      const { adopt } = await gate(train, fact.id, lesson.terms);
      await lessons.updateOne({ _id: lesson._id }, { $set: { adopted: adopt } });
      if (!g) continue;
      const base = evidenceIn(await retrieve(held, fact.id, RETRIEVAL_K, PARSER, "hybrid"), g, fact);
      const naive = evidenceIn(await searchWith(held, fact.id, lesson.terms), g, fact);
      rows.push({ fact: fact.id, ticker: held, base, naive, gated: adopt ? naive : base, adopted: adopt });
    }
  }

  // The lessons a future run would use: learned from, and gated on, all five companies.
  for (const fact of FACTS) {
    const lesson = await learn(TICKERS, fact.id, "all");
    const { adopt, gained } = await gate(TICKERS, fact.id, lesson.terms);
    await lessons.updateOne({ _id: lesson._id }, { $set: { adopted: adopt && gained > 0 } });
  }

  const pct = (n: number) => `${n}/${rows.length} (${((100 * n) / rows.length).toFixed(1)}%)`;
  console.log(`\nretrieval recall@${RETRIEVAL_K}, leave-one-company-out (${rows.length} held-out facts, parser ${PARSER}, hybrid):`);
  console.log(`  no lessons:            ${pct(rows.filter((r) => r.base).length)}`);
  console.log(`  every lesson (naive):  ${pct(rows.filter((r) => r.naive).length)}`);
  console.log(`  gated lessons:         ${pct(rows.filter((r) => r.gated).length)}   (${rows.filter((r) => r.adopted).length} lessons adopted)`);
  for (const [name, key] of [["naive", "naive"], ["gated", "gated"]] as const) {
    console.log(`\n${name} gained:`, rows.filter((r) => !r.base && r[key]).map((r) => `${r.ticker}:${r.fact}`).join(", ") || "none");
    console.log(`${name} lost:  `, rows.filter((r) => r.base && !r[key]).map((r) => `${r.ticker}:${r.fact}`).join(", ") || "none");
  }
  console.log("\nlessons future runs would use (learned from all five, adopted only if they gain evidence and lose none):");
  for (const l of await lessons.find({ scope: "all" }).sort({ factId: 1 }).toArray())
    console.log(`  ${(l as Lesson & { adopted?: boolean }).adopted ? "ADOPT " : "reject"} ${l.factId.padEnd(34)} + ${l.terms.join(" ") || "(none)"}`);
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
