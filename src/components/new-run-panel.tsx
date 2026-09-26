"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, PlayIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ModeInfo } from "@/components/mode-badge";
import { COMPANIES } from "@/lib/companies";
import { MODEL_PROFILES } from "@/lib/config";
import { FACTS } from "@/lib/facts";
import { modelProvider, shortModel } from "@/lib/format";
import type { Mode } from "@/lib/types";
import { cn } from "@/lib/utils";

const ALL_MODELS = [...new Set(Object.values(MODEL_PROFILES).flat())];

const MODE_INFO: Record<Mode, { label: string; hint: string }> = {
  e2e: { label: "Full pipeline", hint: "search → read → cite" },
  oracle: { label: "Reading only", hint: "handed the verified evidence" },
};

export function NewRunPanel({ className }: { className?: string }) {
  const router = useRouter();
  const [models, setModels] = useState<string[]>(MODEL_PROFILES.dev ?? []);
  const [modes, setModes] = useState<Mode[]>(["e2e", "oracle"]);
  const [tickers, setTickers] = useState<string[]>(COMPANIES.map((c) => c.ticker));
  const [label, setLabel] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const calls = models.length * modes.length * tickers.length * FACTS.length;
  const activePreset = useMemo(
    () =>
      Object.entries(MODEL_PROFILES).find(
        ([, list]) => list.length === models.length && list.every((m) => models.includes(m)),
      )?.[0],
    [models],
  );

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          models,
          modes,
          tickers: tickers.length === COMPANIES.length ? undefined : tickers,
          label: label.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !data.id) throw new Error(data.error || `Request failed (${res.status})`);
      router.push(`/runs/${encodeURIComponent(data.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  }

  return (
    <section className={cn("rounded-lg border bg-card", className)}>
      <div className="border-b px-4 py-3">
        <h2 className="text-[13px] font-semibold">New run</h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          Every model sees identical retrieved context; results stream into the grid.
        </p>
      </div>

      <div className="space-y-4 px-4 py-3">
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Models</span>
            <div className="flex gap-1">
              {Object.keys(MODEL_PROFILES).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setModels(MODEL_PROFILES[p])}
                  className={cn(
                    "rounded border px-1.5 py-0.5 text-[11px] transition-colors",
                    activePreset === p
                      ? "border-foreground bg-foreground text-background"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-0.5">
            {ALL_MODELS.map((m) => (
              <label
                key={m}
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[13px] hover:bg-muted/60"
              >
                <Checkbox checked={models.includes(m)} onCheckedChange={() => setModels((s) => toggle(s, m))} />
                <span className="font-mono text-[12px]">{shortModel(m)}</span>
                <span className="ml-auto text-[11px] text-muted-foreground">{modelProvider(m)}</span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Modes <ModeInfo className="normal-case" />
          </div>
          <div className="space-y-0.5">
            {(Object.keys(MODE_INFO) as Mode[]).map((m) => (
              <label
                key={m}
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[13px] hover:bg-muted/60"
              >
                <Checkbox checked={modes.includes(m)} onCheckedChange={() => setModes((s) => toggle(s, m))} />
                <span>{MODE_INFO[m].label}</span>
                <span className="ml-auto text-[11px] text-muted-foreground">{MODE_INFO[m].hint}</span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Companies</div>
          <div className="flex flex-wrap gap-1">
            {COMPANIES.map((c) => {
              const on = tickers.includes(c.ticker);
              return (
                <button
                  key={c.ticker}
                  type="button"
                  title={c.company}
                  onClick={() => setTickers((s) => toggle(s, c.ticker))}
                  className={cn(
                    "rounded border px-2 py-0.5 font-mono text-[11px] transition-colors",
                    on ? "border-foreground/70 bg-muted text-foreground" : "text-muted-foreground/70 line-through",
                  )}
                >
                  {c.ticker}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Label</div>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="optional, e.g. demo-baseline"
            className="h-8 text-[13px]"
          />
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {calls.toLocaleString()} fact extractions
          </span>
          <Button
            size="sm"
            onClick={submit}
            disabled={pending || models.length === 0 || modes.length === 0 || tickers.length === 0}
          >
            {pending ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
            Start run
          </Button>
        </div>
        {error ? (
          <p className="rounded border border-red-200 bg-red-50 px-2.5 py-2 text-[12px] text-red-900">{error}</p>
        ) : null}
      </div>
    </section>
  );
}
