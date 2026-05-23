import type { PdfLine } from './types';

/** Tolerance in PDF user-space units for considering two text items "on the same line". */
const Y_TOLERANCE = 1;

type TextItem = {
  str: string;
  transform: number[]; // [scaleX, skewY, skewX, scaleY, x, y]
  width: number;
};

/**
 * Extract text lines from a PDF buffer.
 *
 * Strategy: pdfjs returns positioned text items per page. We bucket items by y-coord
 * (within Y_TOLERANCE), sort each bucket left-to-right by x, and join with the
 * minimum number of spaces needed to keep column gaps detectable (1 space if items
 * touch, more spaces proportional to the x-gap).
 *
 * Uses a dynamic import because pdfjs-dist v5 is ESM-only and the backend is
 * compiled to CommonJS (tsconfig.json `module: commonjs`). Dynamic import works
 * in both module systems and lets `tsx` do the right thing at runtime.
 */
export async function extractPdfLines(buffer: Buffer): Promise<PdfLine[]> {
  // The "legacy" build avoids the Web Worker; required in Node.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
  }).promise;

  const out: PdfLine[] = [];

  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      const items = (content.items as TextItem[]).filter((it) => typeof it.str === 'string');

      type Bucket = { y: number; items: TextItem[] };
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

      buckets.sort((a, b) => b.y - a.y);
      for (const b of buckets) {
        b.items.sort((a, c) => a.transform[4] - c.transform[4]);
        const parts: string[] = [];
        let prevRight = -Infinity;
        let prevSpaceWidth = 0;
        for (const it of b.items) {
          const x = it.transform[4];
          const gap = x - prevRight;
          if (parts.length === 0) {
            parts.push(it.str);
          } else {
            const spaceWidth = prevSpaceWidth || 4;
            const spaces = Math.max(1, Math.round(gap / spaceWidth));
            parts.push(' '.repeat(Math.min(spaces, 40)) + it.str);
          }
          prevRight = x + it.width;
          prevSpaceWidth = it.width > 0 && it.str.length > 0 ? it.width / it.str.length : prevSpaceWidth;
        }
        const text = parts.join('').replace(/\s+$/, '');
        if (text.length > 0) out.push({ page: pageNum, y: b.y, text });
      }

      page.cleanup();
    }

    return out;
  } finally {
    await doc.destroy();
  }
}
