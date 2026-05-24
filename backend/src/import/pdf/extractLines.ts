import type { PdfLine, PdfTextSpan } from './types';

/** Tolerance in PDF user-space units for considering two text items "on the same line". */
const Y_TOLERANCE = 1;

type TextItem = {
  str: string;
  transform: number[]; // [scaleX, skewY, skewX, scaleY, x, y]
  width: number;
};

type Bucket = { y: number; items: TextItem[] };

function bucketByY(items: TextItem[]): Bucket[] {
  const buckets: Bucket[] = [];
  for (const it of items) {
    const y = it.transform[5];
    const found = buckets.find((b) => Math.abs(b.y - y) <= Y_TOLERANCE);
    if (found) {
      found.items.push(it);
      found.y = (found.y + y) / 2;
    } else {
      buckets.push({ y, items: [it] });
    }
  }
  return buckets;
}

function sortedItems(items: TextItem[]): TextItem[] {
  return [...items].sort((a, c) => a.transform[4] - c.transform[4]);
}

function joinBucket(items: TextItem[]): string {
  const sorted = sortedItems(items);
  const parts: string[] = [];
  let prevRight = -Infinity;
  let prevSpaceWidth = 0;
  for (const it of sorted) {
    const x = it.transform[4];
    if (parts.length === 0) {
      parts.push(it.str);
    } else {
      const gap = x - prevRight;
      const spaceWidth = prevSpaceWidth || 4;
      const spaces = Math.max(1, Math.round(gap / spaceWidth));
      parts.push(' '.repeat(Math.min(spaces, 40)) + it.str);
    }
    prevRight = x + it.width;
    if (it.width > 0 && it.str.length > 0) {
      prevSpaceWidth = it.width / it.str.length;
    }
  }
  return parts.join('').replace(/\s+$/, '');
}

function bucketToSpans(items: TextItem[]): PdfTextSpan[] {
  const sorted = sortedItems(items);
  const merged: PdfTextSpan[] = [];
  for (const it of sorted) {
    const x = it.transform[4];
    const last = merged[merged.length - 1];
    // Coalesce adjacent fragments emitted by pdfjs for the same visual token.
    if (last && x - (last.x + last.width) < 0.5) {
      last.str += it.str;
      last.width = x + it.width - last.x;
    } else {
      merged.push({ x, width: it.width, str: it.str });
    }
  }
  return merged.filter((m) => m.str.trim().length > 0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function extractPageLines(page: any, pageNum: number): Promise<PdfLine[]> {
  const content = await page.getTextContent();
  const items = (content.items as TextItem[]).filter((it) => typeof it.str === 'string');
  const buckets = bucketByY(items);
  buckets.sort((a, b) => b.y - a.y);
  const out: PdfLine[] = [];
  for (const b of buckets) {
    const text = joinBucket(b.items);
    if (text.length > 0) {
      out.push({ page: pageNum, y: b.y, text, items: bucketToSpans(b.items) });
    }
  }
  return out;
}

/**
 * Extract text lines from a PDF buffer.
 *
 * Strategy: pdfjs returns positioned text items per page. We bucket items by y-coord
 * (within Y_TOLERANCE), sort each bucket left-to-right by x, and join with the
 * minimum number of spaces needed to keep column gaps detectable (1 space if items
 * touch, more spaces proportional to the x-gap). Each line also carries the
 * raw positioned spans so column-sensitive parsers (RBC personal banking) can
 * disambiguate withdrawals vs deposits by x-coordinate.
 *
 * Uses a dynamic import because pdfjs-dist v5 is ESM-only and the backend is
 * compiled to CommonJS (tsconfig.json `module: commonjs`). Dynamic import works
 * in both module systems and lets `tsx` do the right thing at runtime.
 */
export async function extractPdfLines(buffer: Buffer): Promise<PdfLine[]> {
  // The "legacy" build avoids the Web Worker; required in Node.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true }).promise;
  try {
    const out: PdfLine[] = [];
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      out.push(...await extractPageLines(page, pageNum));
      page.cleanup();
    }
    return out;
  } finally {
    await doc.destroy();
  }
}
