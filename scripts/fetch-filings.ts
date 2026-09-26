import "./_env";
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { COMPANIES } from "@/lib/companies";

// Downloads each company's latest DEF 14A from SEC EDGAR and prints it to PDF with local Chrome.
// Usage: pnpm filings [--tickers AAPL,MSFT]

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UA = process.env.SEC_USER_AGENT;

export interface ManifestEntry {
  ticker: string;
  company: string;
  cik: string;
  form: string;
  accession: string;
  filingDate: string;
  sourceUrl: string;
  pdfPath: string;
}

async function sec(url: string): Promise<Response> {
  const res = await fetch(url, { headers: { "User-Agent": UA!, "Accept-Encoding": "gzip, deflate" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res;
}

async function latestProxy(cik: string) {
  const padded = cik.padStart(10, "0");
  const data = (await (await sec(`https://data.sec.gov/submissions/CIK${padded}.json`)).json()) as {
    filings: { recent: { form: string[]; accessionNumber: string[]; filingDate: string[]; primaryDocument: string[] } };
  };
  const r = data.filings.recent;
  const i = r.form.findIndex((f) => f === "DEF 14A");
  if (i === -1) throw new Error(`no DEF 14A found for CIK ${cik}`);
  const accession = r.accessionNumber[i];
  const dir = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}`;
  return { accession, filingDate: r.filingDate[i], dir, url: `${dir}/${r.primaryDocument[i]}` };
}

async function main() {
  if (!UA) throw new Error('SEC_USER_AGENT is not set. Add e.g. "Jane Doe jane@example.com" to .env');
  const arg = process.argv.indexOf("--tickers");
  const only = arg > -1 ? process.argv[arg + 1].split(",") : null;
  const targets = COMPANIES.filter((c) => !only || only.includes(c.ticker));

  await fs.mkdir("data/filings", { recursive: true });
  await fs.mkdir("public/filings", { recursive: true });
  const manifestPath = "data/filings/manifest.json";
  const manifest: Record<string, ManifestEntry> = JSON.parse(await fs.readFile(manifestPath, "utf8").catch(() => "{}"));

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  try {
    for (const c of targets) {
      const t0 = Date.now();
      const p = await latestProxy(c.cik);
      const html = await (await sec(p.url)).text();
      await fs.writeFile(path.join("data/filings", `${c.ticker}.html`), html);

      // <base> makes relative image links resolve against EDGAR.
      const withBase = html.replace(/<head([^>]*)>/i, `<head$1><base href="${p.dir}/">`);
      const page = await browser.newPage();
      await page.setUserAgent({ userAgent: UA });
      await page.setViewport({ width: 816, height: 1056 });
      await page.setContent(withBase.includes("<base") ? withBase : `<base href="${p.dir}/">${html}`, {
        waitUntil: "load",
        timeout: 120_000,
      }).catch(() => undefined); // proceed with whatever loaded

      // Shrink wide filings to fit the page instead of clipping tables.
      const contentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const printable = 816 - 2 * 48;
      const scale = Math.max(0.5, Math.min(1, printable / contentWidth));
      const pdfPath = `/filings/${c.ticker}.pdf`;
      await page.pdf({
        path: path.join("public", pdfPath),
        format: "letter",
        printBackground: true,
        scale,
        margin: { top: "0.5in", bottom: "0.5in", left: "0.5in", right: "0.5in" },
      });
      await page.close();

      manifest[c.ticker] = {
        ticker: c.ticker, company: c.company, cik: c.cik, form: "DEF 14A",
        accession: p.accession, filingDate: p.filingDate, sourceUrl: p.url, pdfPath,
      };
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      console.log(`${c.ticker}: ${p.filingDate} ${p.accession} → public${pdfPath} (scale ${scale.toFixed(2)}, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
