// A deliberate mix of governance setups so votes come out both ways:
// combined CEO/chair with and without a lead director, and dual-class stock.
export const COMPANIES = [
  { ticker: "AAPL", company: "Apple Inc.", cik: "320193" },
  { ticker: "MSFT", company: "Microsoft Corporation", cik: "789019" },
  { ticker: "GOOGL", company: "Alphabet Inc.", cik: "1652044" },
  { ticker: "META", company: "Meta Platforms, Inc.", cik: "1326801" },
  { ticker: "JPM", company: "JPMorgan Chase & Co.", cik: "19617" },
] as const;

export type CompanyTicker = (typeof COMPANIES)[number]["ticker"];
