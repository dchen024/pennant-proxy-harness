import { cn } from "@/lib/utils";

type Op = { kind: "same" | "del" | "add"; text: string };

/** Word-level diff (longest common subsequence over whitespace-separated words). */
export function diffWords(before: string, after: string): Op[] {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: Op[] = [];
  const push = (kind: Op["kind"], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.kind === kind) last.text += ` ${text}`;
    else ops.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) push("del", a[i++]);
    else push("add", b[j++]);
  }
  while (i < n) push("del", a[i++]);
  while (j < m) push("add", b[j++]);
  return ops;
}

/** Inline before → after diff; a null `before` renders the whole text as an addition. */
export function WordDiff({ before, after, className }: { before: string | null; after: string; className?: string }) {
  const ops: Op[] = before === null ? [{ kind: "add", text: after }] : diffWords(before, after);
  return (
    <p className={cn("text-[12.5px] leading-relaxed", className)} data-diff>
      {ops.map((op, k) => (
        <span key={k}>
          {k > 0 ? " " : null}
          <span
            className={cn(
              op.kind === "del" && "rounded-[2px] bg-red-100 text-red-900 line-through decoration-red-400",
              op.kind === "add" && "rounded-[2px] bg-emerald-100 text-emerald-950",
            )}
            data-diff-op={op.kind}
          >
            {op.text}
          </span>
        </span>
      ))}
    </p>
  );
}
