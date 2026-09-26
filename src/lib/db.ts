import { MongoClient, type Db } from "mongodb";
import { TEXT_INDEX, VECTOR_INDEX } from "./config";
import type { Chunk, ConfigDoc, FactResult, FilingDoc, GoldFact, Policy, ProposalDoc, RetrievalCache, RunDoc } from "./types";

declare global {
  var __mongoClient: Promise<MongoClient> | undefined;
}

export async function getDb(): Promise<Db> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set. Add it to .env");
  globalThis.__mongoClient ??= new MongoClient(uri, { appName: "pennant-proxy-harness", serverSelectionTimeoutMS: 8000 })
    .connect()
    .catch((err) => {
      globalThis.__mongoClient = undefined; // don't cache a failed connection
      throw err;
    });
  const client = await globalThis.__mongoClient;
  return client.db(process.env.MONGODB_DB || "pennant_harness");
}

export async function collections() {
  const db = await getDb();
  return {
    filings: db.collection<FilingDoc>("filings"),
    chunks: db.collection<Chunk>("chunks"),
    gold: db.collection<GoldFact>("gold"),
    runs: db.collection<RunDoc>("runs"),
    results: db.collection<FactResult>("results"),
    retrievals: db.collection<RetrievalCache>("retrievals"),
    policies: db.collection<Policy & { _id: string; compiledBy?: string; createdAt: string }>("policies"),
    configs: db.collection<ConfigDoc>("configs"),
    proposals: db.collection<ProposalDoc>("proposals"),
  };
}

export async function closeDb() {
  if (!globalThis.__mongoClient) return;
  const client = await globalThis.__mongoClient;
  await client.close();
  globalThis.__mongoClient = undefined;
}

export async function ensureIndexes() {
  const c = await collections();
  await c.chunks.createIndex({ ticker: 1, page: 1 });
  await c.results.createIndex({ runId: 1, model: 1, mode: 1 });
  await c.results.createIndex({ runId: 1, ticker: 1, factId: 1 });
  await c.gold.createIndex({ ticker: 1, factId: 1 }, { unique: true });
}

/** Creates the Atlas Vector Search index on chunk embeddings (if missing) and waits until it is queryable. */
export async function ensureVectorIndex(numDimensions: number) {
  const { chunks } = await collections();
  const definition = {
    fields: [
      { type: "vector", path: "embedding", numDimensions, similarity: "cosine" },
      { type: "filter", path: "ticker" },
      { type: "filter", path: "parserVersion" },
    ],
  };
  const [existing] = await chunks.listSearchIndexes(VECTOR_INDEX).toArray();
  if (!existing) {
    await chunks.createSearchIndex({ name: VECTOR_INDEX, type: "vectorSearch", definition });
  } else if (!JSON.stringify((existing as { latestDefinition?: unknown }).latestDefinition ?? {}).includes("parserVersion")) {
    await chunks.updateSearchIndex(VECTOR_INDEX, definition);
    await new Promise((r) => setTimeout(r, 5000));
  }
  for (let i = 0; i < 120; i++) {
    const [idx] = (await chunks.listSearchIndexes(VECTOR_INDEX).toArray()) as {
      queryable?: boolean;
      status?: string;
      latestDefinition?: unknown;
    }[];
    const current = JSON.stringify(idx?.latestDefinition ?? {}).includes("parserVersion");
    if (idx?.queryable && idx.status === "READY" && current) return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`Vector index ${VECTOR_INDEX} did not become queryable in time`);
}

/** Atlas Search (Lucene) index for keyword retrieval over chunk text and carried-over context. */
export async function ensureTextIndex() {
  const { chunks } = await collections();
  const [existing] = await chunks.listSearchIndexes(TEXT_INDEX).toArray();
  if (!existing) {
    await chunks.createSearchIndex({
      name: TEXT_INDEX,
      type: "search",
      definition: {
        mappings: {
          dynamic: false,
          fields: {
            text: { type: "string", analyzer: "lucene.english" },
            context: { type: "string", analyzer: "lucene.english" },
            ticker: { type: "token" },
            parserVersion: { type: "token" },
          },
        },
      },
    });
  }
  for (let i = 0; i < 120; i++) {
    const [idx] = (await chunks.listSearchIndexes(TEXT_INDEX).toArray()) as { queryable?: boolean; status?: string }[];
    if (idx?.queryable && idx.status === "READY") return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`Search index ${TEXT_INDEX} did not become queryable in time`);
}
