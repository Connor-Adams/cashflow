import type { PdfLine, PdfTextSpan } from './types';
import { logger } from '../../observability/logger';

/** Tolerance in PDF user-space units for considering two text items "on the same line". */
const Y_TOLERANCE = 1;

/**
 * Resource caps guarding against CPU/memory exhaustion from crafted PDFs (issue #872).
 * `/preview` is auth + rate-limited, so these bound authenticated abuse rather than
 * anonymous DoS, but a small (<15 MB) file can still expand to an enormous fragment
 * count or page count via pdfjs.
 */
/** Maximum positioned text items processed per page; extras are dropped with a warning. */
const MAX_ITEMS_PER_PAGE = 50_000;
/** Maximum pages parsed; pages beyond this are skipped with a warning. */
const MAX_PAGES = 500;
/** Wall-clock budget for the whole extract; exceeding it stops the page loop early. */
const EXTRACT_BUDGET_MS = 30_000;

type TextItem = {
  str: string;
  transform: number[]; // [scaleX, skewY, skewX, scaleY, x, y]
  width: number;
};

type Bucket = { y: number; items: TextItem[] };

/**
 * Group text items into lines by y-coordinate in O(N log N).
 *
 * Earlier code did `buckets.find(...)` inside the per-item loop — O(N²) on a PDF
 * whose glyphs land on many distinct y-coords (issue #872). Instead we sort items
 * by y once (descending = top-of-page first, since pdfjs y grows upward) and sweep
 * linearly: each item either extends the current bucket (within Y_TOLERANCE of its
 * running y) or starts a new one. Because the input is sorted, every same-line item
 * is adjacent, so a single comparison against the current bucket suffices.
 */
export function bucketByY(items: TextItem[]): Bucket[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => b.transform[5] - a.transform[5]);
  const buckets: Bucket[] = [];
  let current: Bucket | null = null;
  for (const it of sorted) {
    const y = it.transform[5];
    if (current && Math.abs(current.y - y) <= Y_TOLERANCE) {
      current.items.push(it);
      // Track a running mean so a slowly-drifting line stays one bucket.
      current.y = (current.y * (current.items.length - 1) + y) / current.items.length;
    } else {
      current = { y, items: [it] };
      buckets.push(current);
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
  let items = (content.items as TextItem[]).filter((it) => typeof it.str === 'string');
  if (items.length > MAX_ITEMS_PER_PAGE) {
    logger.warn(
      { pageNum, itemCount: items.length, cap: MAX_ITEMS_PER_PAGE },
      'pdf_extract_items_truncated',
    );
    items = items.slice(0, MAX_ITEMS_PER_PAGE);
  }
  const buckets = bucketByY(items);
  // bucketByY already returns buckets top-of-page first (sorted by descending y).
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
 * Resource bounds (issue #872): the per-page item count, the page count, and the
 * overall wall-clock time are capped so a crafted PDF cannot exhaust CPU or heap.
 * Truncation is logged, not thrown — a partial parse is better than a 500.
 *
 * Uses a dynamic import because pdfjs-dist v5 is ESM-only and the backend is
 * compiled to CommonJS (tsconfig.json `module: commonjs`). Dynamic import works
 * in both module systems and lets `tsx` do the right thing at runtime.
 */
export async function extractPdfLines(buffer: Buffer): Promise<PdfLine[]> {
  // The "legacy" build avoids the Web Worker; required in Node.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdfjs.getDocument takes ownership of the typed array and detaches its
  // underlying ArrayBuffer when parsing completes. Copy the bytes into a
  // fresh ArrayBuffer so the caller's Buffer stays usable for a second pass
  // (the RBC bundle flow extracts lines for the header, then re-extracts
  // inside parseStatementFile) and so other multer files sharing a pooled
  // ArrayBuffer are not collateral-detached.
  const data = new Uint8Array(buffer.byteLength);
  data.set(buffer);
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true }).promise;
  try {
    const out: PdfLine[] = [];
    const pageCount = doc.numPages;
    const pageLimit = Math.min(pageCount, MAX_PAGES);
    if (pageCount > MAX_PAGES) {
      logger.warn(
        { pageCount, cap: MAX_PAGES },
        'pdf_extract_pages_truncated',
      );
    }
    const deadline = Date.now() + EXTRACT_BUDGET_MS;
    for (let pageNum = 1; pageNum <= pageLimit; pageNum++) {
      if (Date.now() > deadline) {
        logger.warn(
          { pageNum, pageLimit, budgetMs: EXTRACT_BUDGET_MS },
          'pdf_extract_budget_exceeded',
        );
        break;
      }
      const page = await doc.getPage(pageNum);
      out.push(...await extractPageLines(page, pageNum));
      page.cleanup();
    }
    return out;
  } finally {
    await doc.destroy();
  }
}
