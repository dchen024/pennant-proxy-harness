import fs from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { BBox, Chunk, ChunkLine, PageDim } from "../types";

// Turns a PDF into page-anchored chunks. Every line keeps its bounding box, so any
// quote a model cites can be highlighted on the exact page it came from.

interface Item {
  str: string;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  baseline: number;
  h: number;
}

interface Line extends ChunkLine {
  segments: number;
  h: number;
}

const TEXT_CHUNK_CHARS = 1200;
const TABLE_CHUNK_CHARS = 3500;

export async function parsePdf(
  filePath: string,
  ticker: string,
  parserVersion: string,
): Promise<{ pages: PageDim[]; chunks: Chunk[] }> {
  const data = new Uint8Array(await fs.readFile(filePath));
  const task = getDocument({ data, verbosity: 0 });
  const doc = await task.promise;
  const pages: PageDim[] = [];
  const chunks: Chunk[] = [];
  const pageLines: Line[][] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    pages.push({ page: p, width: viewport.width, height: viewport.height });

    const content = await page.getTextContent();
    const items: Item[] = [];
    for (const raw of content.items) {
      if (!("str" in raw)) continue;
      const str = mapGlyphs(raw.str);
      if (!str.trim()) continue;
      const [, , c, d, e, f] = raw.transform as number[];
      const h = Math.hypot(c, d) || raw.height || 10;
      const [x, baseline] = viewport.convertToViewportPoint(e, f);
      items.push({ str, x0: x, x1: x + raw.width, top: baseline - 0.8 * h, bottom: baseline + 0.2 * h, baseline, h });
    }
    pageLines.push(groupLines(items));
    page.cleanup();
  }
  await task.destroy();

  // Running headers/footers ("42 | 2026 Proxy Statement") repeat on many pages; drop them
  // so they don't split chunks or pass for table rows.
  const boilerplate = (text: string) => text.toLowerCase().replace(/\d+/g, "#").trim();
  const seen = new Map<string, number>();
  for (const lines of pageLines)
    for (const key of new Set(lines.map((l) => boilerplate(l.text)))) seen.set(key, (seen.get(key) ?? 0) + 1);
  const cutoff = Math.max(4, Math.ceil(pageLines.length * 0.25));

  pageLines.forEach((all, idx) => {
    const p = idx + 1;
    const lines = all.filter((l) => (seen.get(boilerplate(l.text)) ?? 0) < cutoff);
    chunkPage(lines).forEach((group, i) => {
      chunks.push({
        _id: chunkId(ticker, parserVersion, p, i),
        ticker,
        page: p,
        kind: group.kind,
        text: group.lines.map((l) => l.text).join("\n"),
        lines: group.lines.map(({ text, bbox }) => ({ text, bbox })),
        bbox: union(group.lines.map((l) => l.bbox)),
        parserVersion,
      });
    });
  });
  if (versionNumber(parserVersion) >= 3) attachContext(chunks);
  return { pages, chunks };
}

const versionNumber = (v: string) => Number(v.replace(/^v/, "")) || 0;

/**
 * v3: a table chunk often starts right after its title ("I. Summary compensation table (SCT)"),
 * which lands in the previous chunk, so neither search nor the model can tell what the numbers are.
 * Carry the preceding chunk's heading-like lines and last two lines forward as context.
 */
function attachContext(chunks: Chunk[]) {
  const headingLike = (t: string) => t.length <= 90 && /[a-z]/i.test(t) && !/[.,;]$/.test(t) && t.split(" | ").length <= 2;
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1].text.split("\n");
    const lines = [...new Set([...prev.filter(headingLike).slice(0, 4), ...prev.slice(-2)])];
    chunks[i].context = lines.join("\n").slice(0, 600);
  }
}

// Symbol fonts (Wingdings, Symbol) extract as private-use code points. Map the common ones
// to real characters: an unmapped U+F0FC hid Meta's "Independent" checkmarks from the model.
const GLYPHS: Record<string, string> = {
  "": "✓", "": "✗", "": "☒", "": "☑", "": "☐", "": "☐",
  "": "☐", "": "■", "": "▪", "": "•", "": "➢", "": "→",
};

function mapGlyphs(text: string): string {
  return text.replace(/[-]/g, (ch) => GLYPHS[ch] ?? "");
}

function groupLines(items: Item[]): Line[] {
  const sorted = [...items].sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0);
  // An item joins the current line when it vertically overlaps the line's tallest item,
  // so raised footnote markers like "(1)" stay on their row.
  const clusters: { items: Item[]; core: Item }[] = [];
  for (const it of sorted) {
    const cur = clusters.at(-1);
    const overlap = cur ? Math.min(it.bottom, cur.core.bottom) - Math.max(it.top, cur.core.top) : 0;
    if (cur && overlap >= 0.5 * Math.min(it.bottom - it.top, cur.core.bottom - cur.core.top)) {
      cur.items.push(it);
      if (it.h > cur.core.h) cur.core = it;
    } else {
      clusters.push({ items: [it], core: it });
    }
  }

  return clusters.map((cluster) => {
    const row = cluster.items.sort((a, b) => a.x0 - b.x0);
    const h = Math.max(...row.map((i) => i.h));
    let text = row[0].str;
    let segments = 1;
    for (let i = 1; i < row.length; i++) {
      const gap = row[i].x0 - row[i - 1].x1;
      if (gap > Math.max(6, 1.0 * h)) {
        text += " | ";
        segments++;
      } else if (gap > 0.12 * h && !text.endsWith(" ") && !row[i].str.startsWith(" ")) {
        text += " ";
      }
      text += row[i].str;
    }
    // A currency sign in its own column belongs to the number after it, and a "$" right
    // after a number starts the next column.
    text = text
      .replace(/\$\s*\|\s*/g, "$")
      .replace(/([\d—–)])\s+\$/g, "$1 | $")
      .replace(/\s+/g, " ")
      .trim();
    segments = text.split(" | ").length;
    const bbox: BBox = [
      Math.min(...row.map((i) => i.x0)),
      Math.min(...row.map((i) => i.top)),
      Math.max(...row.map((i) => i.x1)),
      Math.max(...row.map((i) => i.bottom)),
    ];
    return { text, bbox, segments, h };
  });
}

function isTableRow(line: Line) {
  return line.segments >= 3 || (line.segments >= 2 && /\d/.test(line.text));
}

/** Text chunks break on size or paragraph gaps; table runs stay together with their caption, and long tables repeat their header rows. */
function chunkPage(lines: Line[]): { kind: "text" | "table"; lines: Line[] }[] {
  const out: { kind: "text" | "table"; lines: Line[] }[] = [];
  if (lines.length === 0) return out;
  const heights = lines.map((l) => l.bbox[3] - l.bbox[1]).sort((a, b) => a - b);
  const mh = heights[Math.floor(heights.length / 2)] || 10;

  let cur: Line[] = [];
  let kind: "text" | "table" = "text";
  const flush = () => {
    if (cur.length) out.push({ kind, lines: cur });
    cur = [];
  };
  const size = () => cur.reduce((n, l) => n + l.text.length + 1, 0);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const gap = i > 0 ? line.bbox[1] - lines[i - 1].bbox[3] : 0;
    const table = isTableRow(line);

    if (table && kind === "text") {
      // The last lines before a table (title, "in thousands" note) move into the table chunk.
      const caption = cur.slice(-2).filter((l) => line.bbox[1] - l.bbox[3] < 4 * mh);
      cur = cur.slice(0, cur.length - caption.length);
      flush();
      cur = [...caption];
      kind = "table";
    } else if (!table && kind === "table") {
      const next = lines[i + 1];
      if (next && isTableRow(next) && gap < 2 * mh) {
        cur.push(line); // single-cell row inside a table (e.g. a section label)
        continue;
      }
      flush();
      kind = "text";
    }

    const limit = kind === "table" ? TABLE_CHUNK_CHARS : TEXT_CHUNK_CHARS;
    if (cur.length && (size() + line.text.length > limit || (kind === "text" && gap > 1.8 * mh && size() > 300))) {
      const header = kind === "table" ? cur.slice(0, 3) : [];
      flush();
      cur = [...header];
    }
    cur.push(line);
  }
  flush();
  return out;
}

/** Chunk ids carry the parser version (except v1/v2, which predate versioning) so versions can coexist. */
export function chunkId(ticker: string, parserVersion: string, page: number, index: number): string {
  return parserVersion === "v1" || parserVersion === "v2" ? `${ticker}:p${page}:${index}` : `${ticker}:${parserVersion}:p${page}:${index}`;
}

function union(boxes: BBox[]): BBox {
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}
