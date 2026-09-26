"use client";

import { useState } from "react";
import { modeLabel } from "@/components/mode-badge";
import { formatCost, formatPct, modelName } from "@/lib/format";
import type { Mode, ModelSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

const W = 560;
const H = 300;
const M = { top: 16, right: 20, bottom: 40, left: 46 };
const ACCENT = "#0369a1"; // one hue; identity comes from direct labels and the tooltip
const SURFACE = "#ffffff";

function logTicks(min: number, max: number): number[] {
  const lo = Math.floor(Math.log10(min));
  const hi = Math.ceil(Math.log10(max));
  const ticks: number[] = [];
  for (let e = lo; e <= hi; e++) {
    for (const m of hi - lo <= 1 ? [1, 2, 5] : [1]) {
      const v = m * 10 ** e;
      if (v >= min * 0.999 && v <= max * 1.001) ticks.push(v);
    }
  }
  return ticks.length >= 2 ? ticks : [min, max];
}

function costLabel(v: number): string {
  if (v >= 1) return `$${v.toFixed(v >= 10 ? 0 : 1)}`;
  return `$${v.toFixed(Math.max(0, -Math.floor(Math.log10(v))))}`;
}

type Point = ModelSummary & { acc: number; cost: number; key: string; cx: number; cy: number };

/** Accuracy vs cost per filing (log x) for the selected mode; "both" shows both marker styles. */
export function AccuracyCostChart({
  rows,
  perFiling = 1,
  mode,
}: {
  rows: ModelSummary[];
  perFiling?: number;
  mode: Mode | "both";
}) {
  const [active, setActive] = useState<string | null>(null);
  const shown = rows.filter((r) => mode === "both" || r.mode === mode);
  const usable = shown.filter((r) => r.accuracy !== null && r.costUsd > 0);
  const skipped = shown.length - usable.length;

  if (usable.length === 0) {
    return (
      <div className="flex h-[220px] items-center justify-center text-[12px] text-muted-foreground">
        No graded results with cost yet.
      </div>
    );
  }

  const costs = usable.map((r) => r.costUsd / Math.max(1, perFiling));
  let cMin = Math.min(...costs);
  let cMax = Math.max(...costs);
  if (cMax / cMin < 10) {
    const mid = Math.sqrt(cMin * cMax);
    cMin = Math.min(cMin, mid / 4);
    cMax = Math.max(cMax, mid * 4);
  }
  cMin /= 1.4;
  cMax *= 1.4;
  const accs = usable.map((r) => r.accuracy as number);
  const aMin = Math.max(0, Math.floor((Math.min(...accs) - 0.05) * 10) / 10);
  const aMax = 1;
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;
  // Rounded to 0.01px: Math.log10 can differ in the last bit between the server and the browser,
  // which would otherwise make hydration attributes mismatch.
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const x = (c: number) => r2(M.left + ((Math.log10(c) - Math.log10(cMin)) / (Math.log10(cMax) - Math.log10(cMin))) * iw);
  const y = (a: number) => r2(M.top + (1 - (a - aMin) / (aMax - aMin || 1)) * ih);

  const pts: Point[] = usable.map((r) => {
    const cost = r.costUsd / Math.max(1, perFiling);
    const acc = r.accuracy as number;
    return { ...r, acc, cost, key: `${r.model}::${r.mode}`, cx: x(cost), cy: y(acc) };
  });

  const yTicks: number[] = [];
  const step = aMax - aMin > 0.5 ? 0.2 : aMax - aMin > 0.2 ? 0.1 : 0.05;
  for (let v = aMin; v <= aMax + 1e-9; v += step) yTicks.push(Math.round(v * 100) / 100);
  const xTicks = logTicks(cMin, cMax);

  // Frontier: cheapest-first, keep points that beat every cheaper point (for one mode).
  const frontierMode: Mode = mode === "both" ? (pts.some((p) => p.mode === "e2e") ? "e2e" : "oracle") : mode;
  const frontier: Point[] = [];
  for (const p of pts.filter((q) => q.mode === frontierMode).sort((a, b) => a.cost - b.cost || b.acc - a.acc)) {
    if (frontier.length === 0 || p.acc > frontier[frontier.length - 1].acc) frontier.push(p);
  }
  const onFrontier = new Set(frontier.map((p) => p.key));

  // Greedy label placement: right, left, then diagonals; avoid dots and earlier labels.
  type Box = { x0: number; y0: number; x1: number; y1: number };
  const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  const obstacles: Box[] = pts.map((p) => ({ x0: p.cx - 6, y0: p.cy - 6, x1: p.cx + 6, y1: p.cy + 6 }));
  const candidates = [
    { dx: 8, dy: 0, anchor: "start" as const },
    { dx: -8, dy: 0, anchor: "end" as const },
    { dx: 0, dy: -12, anchor: "middle" as const },
    { dx: 0, dy: 12, anchor: "middle" as const },
    { dx: 6, dy: -11, anchor: "start" as const },
    { dx: 6, dy: 11, anchor: "start" as const },
    { dx: -6, dy: -11, anchor: "end" as const },
    { dx: -6, dy: 11, anchor: "end" as const },
  ];
  const labelText = (p: Point) => `${modelName(p.model)}${mode === "both" && p.mode === "oracle" ? " · reading" : ""}`;
  const labels = new Map<string, { x: number; y: number; anchor: "start" | "end" | "middle" } | null>();
  for (const p of [...pts].sort((a, b) => b.acc - a.acc || a.cost - b.cost)) {
    const w = labelText(p).length * 5.4 + 2;
    let chosen: { x: number; y: number; anchor: "start" | "end" | "middle" } | null = null;
    for (const c of candidates) {
      const lx = r2(p.cx + c.dx);
      const ly = r2(p.cy + c.dy);
      const box: Box =
        c.anchor === "start"
          ? { x0: lx, y0: ly - 6, x1: lx + w, y1: ly + 6 }
          : c.anchor === "end"
            ? { x0: lx - w, y0: ly - 6, x1: lx, y1: ly + 6 }
            : { x0: lx - w / 2, y0: ly - 6, x1: lx + w / 2, y1: ly + 6 };
      const inside = box.x0 >= M.left - 4 && box.x1 <= W - 2 && box.y0 >= 0 && box.y1 <= H - M.bottom;
      if (inside && !obstacles.some((o) => overlaps(o, box))) {
        chosen = { x: lx, y: ly, anchor: c.anchor };
        obstacles.push(box);
        break;
      }
    }
    labels.set(p.key, chosen);
  }
  const hidden = [...labels.values()].filter((l) => l === null).length;

  const act = pts.find((p) => p.key === active) ?? null;
  const describe = (p: Point) =>
    `${modelName(p.model)}, ${modeLabel(p.mode)}: ${formatPct(p.acc)} accurate (${p.correct}/${p.graded}), ${formatCost(p.cost)} per filing, ${p.consequentialErrors} vote-flipping error${p.consequentialErrors === 1 ? "" : "s"}`;

  return (
    <div>
      <div className="relative" data-chart>
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full overflow-visible" role="group" aria-label="Accuracy versus cost per filing by model">
          {/* Recessive chrome: never takes pointer events from the dots. */}
          <g pointerEvents="none">
            {yTicks.map((t) => (
              <g key={`y${t}`}>
                <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} stroke="#ececec" strokeWidth={1} />
                <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-neutral-500 text-[10px] tabular-nums">
                  {Math.round(t * 100)}%
                </text>
              </g>
            ))}
            {xTicks.map((t) => (
              <g key={`x${t}`}>
                <line x1={x(t)} x2={x(t)} y1={M.top} y2={H - M.bottom} stroke="#f3f3f3" strokeWidth={1} />
                <text x={x(t)} y={H - M.bottom + 14} textAnchor="middle" className="fill-neutral-500 text-[10px] tabular-nums">
                  {costLabel(t)}
                </text>
              </g>
            ))}
            <line x1={M.left} x2={W - M.right} y1={H - M.bottom} y2={H - M.bottom} stroke="#d4d4d4" strokeWidth={1} />
            <text x={M.left + iw / 2} y={H - 6} textAnchor="middle" className="fill-neutral-500 text-[10px]">
              {perFiling > 1 ? "Cost per filing (USD, log scale)" : "Run cost (USD, log scale)"}
            </text>
            <text transform={`translate(11 ${M.top + ih / 2}) rotate(-90)`} textAnchor="middle" className="fill-neutral-500 text-[10px]">
              Accuracy
            </text>
            {pts.map((p) => {
              const l = labels.get(p.key);
              if (!l) return null;
              return (
                <text
                  key={`l:${p.key}`}
                  x={l.x}
                  y={l.y}
                  dy="0.32em"
                  textAnchor={l.anchor}
                  className={cn("text-[10px]", onFrontier.has(p.key) || active === p.key ? "fill-neutral-900 font-medium" : "fill-neutral-500")}
                >
                  {labelText(p)}
                </text>
              );
            })}
          </g>

          {/* Dots: each has a 26px hit target and is focusable; hover or focus shows the tooltip. */}
          {pts.map((p) => {
            const isActive = active === p.key;
            const hollow = mode === "both" && p.mode === "oracle";
            return (
              <g
                key={p.key}
                data-point={p.key}
                tabIndex={0}
                role="img"
                aria-label={describe(p)}
                className="cursor-default outline-none"
                onPointerEnter={() => setActive(p.key)}
                onPointerLeave={() => setActive((a) => (a === p.key ? null : a))}
                onFocus={() => setActive(p.key)}
                onBlur={() => setActive((a) => (a === p.key ? null : a))}
              >
                <circle cx={p.cx} cy={p.cy} r={13} fill="transparent" pointerEvents="all" />
                {isActive ? <circle cx={p.cx} cy={p.cy} r={9} fill="none" stroke={ACCENT} strokeOpacity={0.35} strokeWidth={2} pointerEvents="none" /> : null}
                <circle
                  cx={p.cx}
                  cy={p.cy}
                  r={isActive ? 5.5 : 4.5}
                  fill={hollow ? SURFACE : ACCENT}
                  stroke={hollow ? ACCENT : SURFACE}
                  strokeWidth={2}
                  pointerEvents="none"
                />
              </g>
            );
          })}
        </svg>

        {act ? (
          <div
            role="tooltip"
            data-chart-tooltip
            className="pointer-events-none absolute z-20 w-max max-w-[240px] rounded-md border bg-popover px-2.5 py-2 text-[11.5px] shadow-lg"
            style={{
              left: `${(act.cx / W) * 100}%`,
              top: `${(act.cy / H) * 100}%`,
              transform:
                act.cy < 90
                  ? `translate(${act.cx > W * 0.7 ? "-100%" : act.cx < W * 0.3 ? "0%" : "-50%"}, 14px)`
                  : `translate(${act.cx > W * 0.7 ? "-100%" : act.cx < W * 0.3 ? "0%" : "-50%"}, calc(-100% - 14px))`,
            }}
          >
            <div className="font-medium">{modelName(act.model)}</div>
            <div className="mb-1.5 flex items-center gap-1.5 text-muted-foreground">
              <svg width="10" height="10" aria-hidden>
                <circle cx="5" cy="5" r="3.5" fill={mode === "both" && act.mode === "oracle" ? SURFACE : ACCENT} stroke={ACCENT} strokeWidth="1.5" />
              </svg>
              {modeLabel(act.mode)}
            </div>
            <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 tabular-nums">
              <span className="font-mono font-semibold">{formatPct(act.acc)}</span>
              <span className="text-muted-foreground">accuracy ({act.correct}/{act.graded})</span>
              <span className="font-mono font-semibold">{formatCost(act.cost)}</span>
              <span className="text-muted-foreground">{perFiling > 1 ? "per filing" : "run cost"}</span>
              <span className="font-mono font-semibold">{act.consequentialErrors}</span>
              <span className="text-muted-foreground">vote-flipping error{act.consequentialErrors === 1 ? "" : "s"}</span>
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-muted-foreground">
        {mode === "both" ? (
          <>
            <span className="inline-flex items-center gap-1.5">
              <svg width="10" height="10" aria-hidden>
                <circle cx="5" cy="5" r="4" fill={ACCENT} />
              </svg>
              Full pipeline
            </span>
            <span className="inline-flex items-center gap-1.5">
              <svg width="10" height="10" aria-hidden>
                <circle cx="5" cy="5" r="3.5" fill={SURFACE} stroke={ACCENT} strokeWidth="1.5" />
              </svg>
              Reading only (labels end in “· reading”)
            </span>
          </>
        ) : (
          <span>{modeLabel(mode)}: one dot per model</span>
        )}
        <span>Hover or tab to a dot for details.</span>
        {skipped > 0 ? <span>{skipped} model(s) without cost or grades not shown.</span> : null}
        {hidden > 0 ? <span>{hidden} label(s) hidden where dots crowd.</span> : null}
      </div>
    </div>
  );
}
