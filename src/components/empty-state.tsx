import { DatabaseIcon, TerminalIcon } from "lucide-react";
import type { DbStatus } from "@/lib/queries";
import { cn } from "@/lib/utils";

export function EmptyState({
  title,
  children,
  commands,
  className,
}: {
  title: string;
  children?: React.ReactNode;
  commands?: { cmd: string; note?: string }[];
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border border-dashed bg-muted/30 px-6 py-8", className)}>
      <div className="mx-auto max-w-xl">
        <div className="flex items-center gap-2 text-sm font-medium">
          <TerminalIcon className="size-4 text-muted-foreground" />
          {title}
        </div>
        {children ? <div className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{children}</div> : null}
        {commands?.length ? (
          <div className="mt-4 space-y-1.5">
            {commands.map((c) => (
              <div key={c.cmd} className="flex items-baseline gap-3">
                <code className="rounded bg-background px-2 py-1 font-mono text-[12px] ring-1 ring-border">{c.cmd}</code>
                {c.note ? <span className="text-[12px] text-muted-foreground">{c.note}</span> : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function DbBanner({ status }: { status: DbStatus }) {
  if (status.ok) return null;
  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-[13px] text-amber-950">
      <DatabaseIcon className="mt-0.5 size-4 shrink-0" />
      <div>
        <div className="font-medium">
          {status.kind === "no-uri" ? "MongoDB is not configured" : "MongoDB is unreachable"}
        </div>
        <div className="mt-0.5 text-amber-900/80">
          {status.message}
          {status.kind === "no-uri" ? (
            <>
              {" "}
              Set <code className="font-mono">MONGODB_URI</code> (and optionally{" "}
              <code className="font-mono">MONGODB_DB</code>) in <code className="font-mono">.env</code>.
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export const PIPELINE_COMMANDS = [
  { cmd: "pnpm filings", note: "download DEF 14A filings and render PDFs" },
  { cmd: "pnpm ingest", note: "parse PDFs into cited chunks + embeddings" },
  { cmd: "pnpm gold:draft", note: "draft the answer key, then verify it in Review" },
  { cmd: "pnpm harness --profile dev", note: "run models against the answer key" },
];
