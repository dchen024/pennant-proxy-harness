import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SiteNav } from "@/components/site-nav";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Proxy Harness",
  description:
    "Measures how well LLMs apply an investor's proxy-voting policy to DEF 14A filings: accuracy, traceable citations, consequential errors and cost.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <TooltipProvider delayDuration={150}>
          <SiteNav />
          <main className="flex flex-1 flex-col">{children}</main>
        </TooltipProvider>
      </body>
    </html>
  );
}
