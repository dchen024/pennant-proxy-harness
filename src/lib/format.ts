import { FACT_BY_ID } from "./facts";
import type { FactId, FactValue } from "./types";

const EM_DASH = "—";

function usdCompact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${trimZeros((abs / 1e9).toFixed(2))}B`;
  if (abs >= 1e6) return `${sign}$${trimZeros((abs / 1e6).toFixed(abs >= 1e8 ? 0 : abs >= 1e7 ? 1 : 2))}M`;
  if (abs >= 1e3) return `${sign}$${trimZeros((abs / 1e3).toFixed(abs >= 1e5 ? 0 : 1))}K`;
  return `${sign}$${Math.round(abs)}`;
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Formats a fact value for display according to the fact's unit. */
export function formatValue(
  value: FactValue | undefined,
  factId: FactId | string,
  opts: { compact?: boolean } = {},
): string {
  if (value === null || value === undefined) return EM_DASH;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  const unit = FACT_BY_ID[factId as FactId]?.unit;
  switch (unit) {
    case "usd":
      return opts.compact ? usdCompact(value) : `${value < 0 ? "-" : ""}$${Math.round(Math.abs(value)).toLocaleString("en-US")}`;
    case "count":
      return Math.round(value).toLocaleString("en-US");
    case "index":
      return value.toFixed(2);
    default:
      return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
}

/** API cost in USD, 4 decimals by default. */
export function formatCost(usd: number | null | undefined, digits = 4): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return EM_DASH;
  return `$${usd.toFixed(digits)}`;
}

export function formatPct(frac: number | null | undefined, digits = 1): string {
  if (frac === null || frac === undefined || !Number.isFinite(frac)) return EM_DASH;
  return `${(frac * 100).toFixed(digits)}%`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return EM_DASH;
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

export function formatInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return EM_DASH;
  return Math.round(n).toLocaleString("en-US");
}

/** "anthropic/claude-sonnet-5" -> "claude-sonnet-5" */
export function shortModel(model: string): string {
  const i = model.indexOf("/");
  return i >= 0 ? model.slice(i + 1) : model;
}

export function modelProvider(model: string): string {
  const i = model.indexOf("/");
  return i >= 0 ? model.slice(0, i) : "";
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDuration(startIso: string, endIso?: string | null): string {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return EM_DASH;
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Table rows are stored with " | " between cells; show them with a lighter separator. */
export function formatQuote(q: string): string {
  return q.replace(/\s*\|\s*/g, " · ");
}

const BRAND: Record<string, string> = { gpt: "GPT", deepseek: "DeepSeek", gemini: "Gemini", claude: "Claude" };

/** "anthropic/claude-opus-5.5" -> "Claude Opus 5.5"; "openai/gpt-6-sol" -> "GPT-6 Sol". */
export function modelName(model: string): string {
  const parts = shortModel(model).split("-").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const word = BRAND[p.toLowerCase()] ?? (/^[a-z]/.test(p) ? p[0].toUpperCase() + p.slice(1) : p.toUpperCase());
    // "GPT-6": keep the hyphen between an all-caps brand and its version number.
    if (word === "GPT" && /^\d/.test(parts[i + 1] ?? "")) {
      out.push(`GPT-${parts[++i]}`);
      continue;
    }
    out.push(/^v\d/i.test(p) ? p.toUpperCase() : word);
  }
  return out.join(" ");
}
