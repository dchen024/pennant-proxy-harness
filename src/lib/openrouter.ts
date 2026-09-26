import OpenAI from "openai";
import { wrapOpenAI } from "langsmith/wrappers/openai";
import type { z } from "zod";
import { EMBEDDING_MODEL } from "./config";

let client: OpenAI | undefined;

/** OpenAI-compatible client pointed at OpenRouter; traced in LangSmith when LANGSMITH_TRACING=true. */
export function openrouter(): OpenAI {
  if (client) return client;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set. Add it to .env");
  const base = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    timeout: 120_000,
    maxRetries: 2,
    defaultHeaders: { "X-Title": "Pennant Proxy Harness" },
  });
  client = process.env.LANGSMITH_TRACING === "true" ? wrapOpenAI(base) : base;
  return client;
}

export async function embed(texts: string[], model = EMBEDDING_MODEL): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const batch = texts.slice(i, i + 64);
    const resp = await openrouter().embeddings.create({ model, input: batch, encoding_format: "float" });
    const sorted = [...resp.data].sort((a, b) => a.index - b.index);
    out.push(...sorted.map((d) => d.embedding as number[]));
  }
  return out;
}

export interface JsonCallResult<T> {
  data: T | null;
  raw: string;
  malformed: boolean;
  repaired: boolean;
  error?: string;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  routedModel?: string;
}

/** Pulls the first JSON object out of a model reply (handles code fences and stray prose). */
export function parseJsonLoose(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found");
  return JSON.parse(body.slice(start, end + 1));
}

type Usage = { prompt_tokens?: number; completion_tokens?: number; cost?: number };

/** OpenRouter wraps provider failures as "400 Provider returned error"; surface the provider's own message. */
function describeError(err: unknown): string {
  const e = err as { message?: string; error?: { metadata?: { raw?: string; provider_name?: string } } };
  const raw = e.error?.metadata?.raw;
  const base = e.message ?? String(err);
  return raw ? `${base} (${e.error?.metadata?.provider_name ?? "provider"}: ${String(raw).slice(0, 400)})` : base;
}

/**
 * One structured-output call. Asks for strict JSON schema output, validates with zod,
 * and retries once with the validation error if the model returns something malformed.
 */
export async function chatJSON<T>(opts: {
  model: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  jsonSchema: Record<string, unknown>;
  schemaName: string;
  maxTokens?: number;
}): Promise<JsonCallResult<T>> {
  const started = Date.now();
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  let costUsd: number | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let routedModel: string | undefined;
  let raw = "";
  let lastError = "";
  let useSchema = true;

  for (let attempt = 0; attempt < 2; attempt++) {
    let resp: OpenAI.Chat.ChatCompletion;
    try {
      const params = {
        model: opts.model,
        messages,
        temperature: 0,
        max_tokens: opts.maxTokens ?? 4096, // reasoning models spend part of this before answering
        ...(useSchema
          ? { response_format: { type: "json_schema", json_schema: { name: opts.schemaName, strict: true, schema: opts.jsonSchema } } }
          : {}),
        usage: { include: true }, // OpenRouter usage accounting (returns cost)
      };
      resp = (await openrouter().chat.completions.create(
        params as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      )) as OpenAI.Chat.ChatCompletion;
    } catch (err) {
      // Some providers reject parts of JSON Schema (e.g. Anthropic: recursion, large grammars).
      // Retry once with plain JSON instructions; zod still validates the output.
      if (useSchema && (err as { status?: number }).status === 400) {
        useSchema = false;
        attempt--;
        continue;
      }
      return {
        data: null, raw, malformed: false, repaired: false,
        error: describeError(err),
        costUsd, inputTokens, outputTokens, latencyMs: Date.now() - started, routedModel,
      };
    }

    const usage = resp.usage as Usage | undefined;
    if (usage) {
      costUsd = (costUsd ?? 0) + (usage.cost ?? 0);
      inputTokens = (inputTokens ?? 0) + (usage.prompt_tokens ?? 0);
      outputTokens = (outputTokens ?? 0) + (usage.completion_tokens ?? 0);
    }
    routedModel = resp.model;
    raw = resp.choices[0]?.message?.content ?? "";

    try {
      const parsed = opts.schema.safeParse(parseJsonLoose(raw));
      if (parsed.success) {
        return {
          data: parsed.data, raw, malformed: false, repaired: attempt > 0,
          costUsd, inputTokens, outputTokens, latencyMs: Date.now() - started, routedModel,
        };
      }
      lastError = parsed.error.message;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    messages.push(
      { role: "assistant", content: raw },
      { role: "user", content: `That output was invalid (${lastError.slice(0, 300)}). Reply with only a JSON object that matches the schema.` },
    );
  }

  return {
    data: null, raw, malformed: true, repaired: true, error: lastError,
    costUsd, inputTokens, outputTokens, latencyMs: Date.now() - started, routedModel,
  };
}
