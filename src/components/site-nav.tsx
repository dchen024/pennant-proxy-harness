"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ReadOnlyBadge } from "@/components/read-only";
import { READ_ONLY } from "@/lib/readonly";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Leaderboard", match: (p: string) => p === "/" || p.startsWith("/runs") },
  { href: "/review", label: "Review", match: (p: string) => p.startsWith("/review") },
  { href: "/improve", label: "Improve", match: (p: string) => p.startsWith("/improve") },
  { href: "/memory", label: "Memory", match: (p: string) => p.startsWith("/memory") },
  { href: "/policy", label: "Policy", match: (p: string) => p.startsWith("/policy") || p.startsWith("/companies") },
  { href: "/architecture", label: "Architecture", match: (p: string) => p.startsWith("/architecture") },
];

export function SiteNav() {
  const pathname = usePathname() ?? "/";
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex h-12 max-w-[1600px] items-center gap-6 px-5">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <Logo />
          <span className="text-[13px] font-semibold tracking-tight">Proxy Harness</span>
          <span className="rounded-sm border px-1.5 py-px text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            for Pennant
          </span>
        </Link>
        <nav className="flex min-w-0 items-center gap-1 text-[13px] max-md:overflow-x-auto max-md:[scrollbar-width:none]">
          {LINKS.map((l) => {
            const active = l.match(pathname);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={cn(
                  "rounded-md px-2.5 py-1 transition-colors",
                  active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        {READ_ONLY ? <ReadOnlyBadge className="ml-auto" /> : null}
        <div
          className={cn(
            "hidden min-w-0 truncate text-[11px] text-muted-foreground min-[1100px]:block",
            !READ_ONLY && "ml-auto",
          )}
        >
          DEF 14A · policy-driven votes · every number traced to its source
        </div>
      </div>
    </header>
  );
}

function Logo() {
  // A small pennant mark.
  return (
    <svg viewBox="0 0 20 20" className="size-4" aria-hidden>
      <path d="M4 2v16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M5 3l11 4-11 4z" fill="currentColor" />
    </svg>
  );
}
