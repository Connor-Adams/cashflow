import type { PdfLine } from '../types';
import type { ReceiptPdfParser } from './types';

const parsers: ReceiptPdfParser[] = [];

export function registerReceiptPdfParser(parser: ReceiptPdfParser): void {
  if (parsers.some((p) => p.id === parser.id)) {
    throw new Error(`Receipt PDF parser already registered: ${parser.id}`);
  }
  parsers.push(parser);
}

export function findReceiptPdfParser(lines: PdfLine[]): ReceiptPdfParser | null {
  for (const p of parsers) {
    if (p.sniff(lines)) return p;
  }
  return null;
}

/** Test-only — wipe the registry and reset the built-ins guard. */
export function clearReceiptPdfParsersForTest(): void {
  parsers.length = 0;
  builtInsRegistered = false;
}

let builtInsRegistered = false;
export function registerBuiltInReceiptPdfParsers(): void {
  if (builtInsRegistered) return;
  // Lazy require avoids circular init with pdfjs.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { costcoTillReceiptParser } = require('./costcoTillReceipt');
  registerReceiptPdfParser(costcoTillReceiptParser);
  builtInsRegistered = true;
}
