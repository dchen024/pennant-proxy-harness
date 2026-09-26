import { PARSER_VERSION, RETRIEVAL_K, RETRIEVAL_STRATEGY, TEXT_INDEX, VECTOR_INDEX, type RetrievalStrategy } from "../config";
import { collections } from "../db";
import { FACT_BY_ID } from "../facts";
import { embed } from "../openrouter";
import type { Chunk, FactId } from "../types";

const queryVectors = new Map<string, Promise<number[]>>();

function queryVector(text: string): Promise<number[]> {
  if (!queryVectors.has(text)) queryVectors.set(text, embed([text]).then((v) => v[0]));
  return queryVectors.get(text)!;
}

type Hit = { _id: string; score: number };

export async function vectorSearch(ticker: string, query: string, k: number, parserVersion = PARSER_VERSION): Promise<Hit[]> {
  const { chunks } = await collections();
  return chunks
    .aggregate<Hit>([
      {
        $vectorSearch: {
          index: VECTOR_INDEX,
          path: "embedding",
          queryVector: await queryVector(query),
          numCandidates: Math.max(150, k * 20),
          limit: k,
          filter: { ticker, parserVersion },
        },
      },
      { $project: { _id: 1, score: { $meta: "vectorSearchScore" } } },
    ])
    .toArray();
}

/** BM25 keyword search (Atlas Search) over chunk text and its carried-over heading context. */
export async function keywordSearch(ticker: string, query: string, k: number, parserVersion = PARSER_VERSION): Promise<Hit[]> {
  const { chunks } = await collections();
  return chunks
    .aggregate<Hit>([
      {
        $search: {
          index: TEXT_INDEX,
          compound: {
            must: [{ text: { query, path: ["text", "context"] } }],
            filter: [
              { equals: { path: "ticker", value: ticker } },
              { equals: { path: "parserVersion", value: parserVersion } },
            ],
          },
        },
      },
      { $limit: k },
      { $project: { _id: 1, score: { $meta: "searchScore" } } },
    ])
    .toArray();
}

/** Reciprocal rank fusion of vector and keyword rankings (k=60, the standard constant). */
export async function hybridSearch(ticker: string, query: string, k: number, parserVersion = PARSER_VERSION): Promise<Hit[]> {
  const [vec, kw] = await Promise.all([
    vectorSearch(ticker, query, 25, parserVersion),
    keywordSearch(ticker, query, 25, parserVersion),
  ]);
  const fused = new Map<string, number>();
  for (const list of [vec, kw]) list.forEach((h, rank) => fused.set(h._id, (fused.get(h._id) ?? 0) + 1 / (60 + rank)));
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([_id, score]) => ({ _id, score }));
}

/** Top-k chunks for a fact. Cached in Mongo so every model in a comparison sees identical context. */
export async function retrieve(
  ticker: string,
  factId: FactId,
  k = RETRIEVAL_K,
  parserVersion = PARSER_VERSION,
  strategy: RetrievalStrategy = RETRIEVAL_STRATEGY,
): Promise<Chunk[]> {
  const c = await collections();
  const id = `${ticker}:${factId}:${k}:${parserVersion}${strategy === "hybrid" ? ":hybrid" : ""}`;
  let ids = (await c.retrievals.findOne({ _id: id }))?.chunkIds;
  if (!ids) {
    const query = FACT_BY_ID[factId].query;
    const hits = strategy === "hybrid" ? await hybridSearch(ticker, query, k, parserVersion) : await vectorSearch(ticker, query, k, parserVersion);
    ids = hits.map((h) => h._id);
    await c.retrievals.updateOne(
      { _id: id },
      { $set: { ticker, factId, k, chunkIds: ids, scores: hits.map((h) => h.score), createdAt: new Date().toISOString() } },
      { upsert: true },
    );
  }
  const found = await c.chunks.find({ _id: { $in: ids } }, { projection: { embedding: 0 } }).toArray();
  const byId = new Map(found.map((ch) => [ch._id, ch]));
  return ids.map((i) => byId.get(i)).filter((ch): ch is Chunk => Boolean(ch));
}
