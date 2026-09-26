// Model line-ups. Pick one with `--profile`, or pass `--models a,b` to a script.
// Always exact model ids: no routers or "latest" aliases, so every result is attributable to one model.
export const MODEL_PROFILES: Record<string, string[]> = {
  dev: ["openai/gpt-6-luna", "google/gemini-3.8-flash"],
  demo: [
    "anthropic/claude-opus-5.5",
    "anthropic/claude-sonnet-5",
    "openai/gpt-6-sol",
    "openai/gpt-6-luna",
    "google/gemini-3.8-flash",
    "deepseek/deepseek-v4.1-flash",
  ],
};

// Drafts the answer key. Deliberately NOT in the comparison, so no contestant
// is graded against its own answers. Every draft is then human-verified.
export const GOLD_DRAFT_MODELS = ["anthropic/claude-fable-5.1", "openai/gpt-6-astra"];

export const EMBEDDING_MODEL = "voyageai/voyage-4";
export const VECTOR_INDEX = "chunk_vector";
export const TEXT_INDEX = "chunk_text";

/** "vector" = Atlas Vector Search only; "hybrid" = Atlas Search (keyword) + Vector Search fused with RRF. */
export type RetrievalStrategy = "vector" | "hybrid";
export const RETRIEVAL_STRATEGY: RetrievalStrategy = "hybrid";

export const RETRIEVAL_K = 8;
export const GOLD_DRAFT_K = 12;
export const CONCURRENCY = 8;

export const PARSER_VERSION = "v3";
export const PROMPT_VERSION = "v2";

export function resolveModels(args: { profile?: string; models?: string }): string[] {
  if (args.models) return args.models.split(",").map((m) => m.trim()).filter(Boolean);
  const profile = args.profile ?? "dev";
  const models = MODEL_PROFILES[profile];
  if (!models) throw new Error(`Unknown profile "${profile}". Options: ${Object.keys(MODEL_PROFILES).join(", ")}`);
  return models;
}
