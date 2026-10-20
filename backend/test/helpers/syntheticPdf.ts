/**
 * Synthetic PDF layouts for tests: no dependency, no binary fixture, no real data.
 *
 * The real statement and receipt PDFs the parsers were built against are
 * personal financial documents. They are gitignored under
 * backend/test/fixtures/pdf/, so CI never has them. Tests describe a document
 * here as pages of rows of positioned cells, using made-up values, and then
 * either:
 *   - feed `synthPdfLines(pages)` straight to a parser (what extractPdfLines
 *     would return, text-wise), or
 *   - render `synthPdf(pages)` to a real PDF binary for code that needs bytes
 *     (extractPdfLines itself, the upload routes, the async import worker).
 *
 * Both forms come from the same description, and `synthPdfLines` reproduces
 * the column gaps that pdfjs + extractPdfLines reconstruct from the rendered
 * PDF (pdfExtractLines.test.ts checks this), so a parser sees the same text
 * either way.
 */
import type { PdfLine } from '../../src/import/pdf/types';

/** A cell: [0-based character column, text]. */
export type SynthCell = [col: number, text: string];
/** One printed line of the document. An empty row is a blank line. */
export type SynthRow = SynthCell[];
/** One page: rows, top to bottom. */
export type SynthPage = SynthRow[];

/**
 * Courier is monospaced (600/1000 em), so at this size each glyph advances
 * 6pt; the page is widened to 900pt so ~145 columns fit. Keep 10pt: at 7pt
 * pdfjs split every word of a cell into its own text item, so single spaces
 * inside a cell came back as three-space column gaps.
 */
const FONT_SIZE = 10;
const GLYPH_WIDTH = FONT_SIZE * 0.6;
const LEFT_MARGIN = 18;
const TOP_Y = 770;
const ROW_HEIGHT = 11;

function sortedCells(row: SynthRow): SynthRow {
  return [...row].sort((a, b) => a[0] - b[0]);
}

/**
 * Join a row's cells the way extractPdfLines rebuilds them from the rendered
 * PDF: pdfjs collapses a gap of two or more character widths into one space
 * item, which extractPdfLines widens to three spaces; a one-character gap stays
 * a single space. Overlapping cells are a layout bug, so they throw.
 */
function joinRow(row: SynthRow): string {
  let text = '';
  let cursor = 0;
  for (const [col, str] of sortedCells(row)) {
    if (text.length > 0) {
      const gap = col - cursor;
      if (gap < 1) throw new Error(`synthetic layout: cell ${JSON.stringify(str)} at col ${col} overlaps the previous cell`);
      text += gap === 1 ? ' ' : '   ';
    }
    text += str;
    cursor = col + str.length;
  }
  return text;
}

/** The parser-input form of a synthetic document (blank rows dropped, as pdfjs does). */
export function synthPdfLines(pages: SynthPage[]): PdfLine[] {
  const out: PdfLine[] = [];
  pages.forEach((rows, pageIdx) => {
    rows.forEach((row, rowIdx) => {
      if (row.length === 0) return;
      out.push({ page: pageIdx + 1, y: TOP_Y - rowIdx * ROW_HEIGHT, text: joinRow(row) });
    });
  });
  return out;
}

function escapePdfString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function contentStream(rows: SynthPage): string {
  const ops: string[] = [];
  rows.forEach((row, rowIdx) => {
    for (const [col, str] of row) {
      const x = LEFT_MARGIN + col * GLYPH_WIDTH;
      const y = TOP_Y - rowIdx * ROW_HEIGHT;
      ops.push(`BT /F1 ${FONT_SIZE} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${escapePdfString(str)}) Tj ET`);
    }
  });
  return ops.join('\n');
}

/**
 * Render a synthetic document to a valid PDF 1.4 binary: one page per entry,
 * one non-embedded standard-14 Courier font, WinAnsi (latin1) text, one
 * text-show operator per cell. Characters outside Latin-1 are not representable.
 */
export function synthPdf(pages: SynthPage[]): Buffer {
  if (pages.length === 0) throw new Error('synthPdf: need at least one page');
  // Object numbering: 1 catalog, 2 page tree, 3 font, then (page, content) pairs.
  const pageObj = (i: number) => 4 + i * 2;
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  pages.forEach((rows, i) => {
    const stream = contentStream(rows);
    objects[pageObj(i)] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 900 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObj(i) + 1} 0 R >>`;
    objects[pageObj(i) + 1] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = Buffer.byteLength(body, 'latin1');
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++) {
    body += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** Cell helper: right-align `text` so it ends at column `endCol`. */
export function right(endCol: number, text: string): SynthCell {
  return [endCol - text.length, text];
}
