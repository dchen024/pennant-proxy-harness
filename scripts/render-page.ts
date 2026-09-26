import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import puppeteer from "puppeteer-core";

// Renders one PDF page to PNG with pdf.js (the same renderer the UI uses), optionally
// drawing boxes on it to check that source highlights line up with the text.
// Usage: tsx scripts/render-page.ts <TICKER> <page> [out.png] [--boxes '[[x0,y0,x1,y1],...]']

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TYPES: Record<string, string> = { ".mjs": "text/javascript", ".js": "text/javascript", ".pdf": "application/pdf", ".html": "text/html" };

async function main() {
  const [ticker, pageArg, outArg] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--boxes");
  const boxesIdx = process.argv.indexOf("--boxes");
  const boxes = boxesIdx > -1 ? JSON.parse(process.argv[boxesIdx + 1]) : [];
  const out = outArg ?? `data/renders/${ticker}-p${pageArg}.png`;
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const page = `<!doctype html><html><body style="margin:0;background:#fff"><canvas id="c"></canvas><script type="module">
    import * as pdfjs from "/node_modules/pdfjs-dist/build/pdf.mjs";
    pdfjs.GlobalWorkerOptions.workerSrc = "/node_modules/pdfjs-dist/build/pdf.worker.mjs";
    const doc = await pdfjs.getDocument({ url: "/public/filings/${ticker}.pdf" }).promise;
    const p = await doc.getPage(${Number(pageArg)});
    const scale = 1.5, vp = p.getViewport({ scale });
    const canvas = document.getElementById("c"); canvas.width = vp.width; canvas.height = vp.height;
    const ctx = canvas.getContext("2d");
    await p.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
    ctx.fillStyle = "rgba(255, 200, 0, 0.35)"; ctx.strokeStyle = "rgba(220, 120, 0, 0.9)";
    for (const [x0, y0, x1, y1] of ${JSON.stringify(boxes)}) { ctx.fillRect(x0*scale, y0*scale, (x1-x0)*scale, (y1-y0)*scale); ctx.strokeRect(x0*scale, y0*scale, (x1-x0)*scale, (y1-y0)*scale); }
    window.done = true;
  </script></body></html>`;

  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (url === "/") return res.writeHead(200, { "content-type": "text/html" }).end(page);
    const file = path.join(process.cwd(), url);
    if (!file.startsWith(process.cwd()) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  try {
    const tab = await browser.newPage();
    tab.on("pageerror", (e) => console.error("page error:", e));
    tab.on("console", (m) => m.type() === "error" && console.error("console:", m.text()));
    tab.on("requestfailed", (r) => console.error("request failed:", r.url()));
    await tab.goto(`http://127.0.0.1:${port}/`);
    await tab.waitForFunction("window.done === true", { timeout: 60_000 });
    const canvas = await tab.$("#c");
    await canvas!.screenshot({ path: out as `${string}.png` });
    console.log(out);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
