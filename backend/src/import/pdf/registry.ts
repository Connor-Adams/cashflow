import type { PdfLine, PdfParser } from './types';

const parsers: PdfParser[] = [];

export function registerPdfParser(parser: PdfParser): void {
  if (parsers.some((p) => p.id === parser.id)) {
    throw new Error(`PDF parser already registered: ${parser.id}`);
  }
  parsers.push(parser);
}

export function findPdfParser(lines: PdfLine[]): PdfParser | null {
  for (const p of parsers) {
    if (p.sniff(lines)) return p;
  }
  return null;
}

export function listPdfParsers(): readonly PdfParser[] {
  return parsers;
}

/** Test-only — wipe the registry and reset the built-ins guard. Production code never calls this. */
export function clearPdfParsersForTest(): void {
  parsers.length = 0;
  builtInsRegistered = false;
}

/**
 * Register built-in parsers. Called once at app boot from parseStatementFile
 * (lazy, via a one-shot guard) and from tests that need built-ins after a clear.
 */
let builtInsRegistered = false;
export function registerBuiltInPdfParsers(): void {
  if (builtInsRegistered) return;
  // Lazy require avoids circular module init with extractLines/pdfjs-dist.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { cibcCostcoMastercardParser } = require('./cibcCostcoMastercard');
  registerPdfParser(cibcCostcoMastercardParser);
  builtInsRegistered = true;
}
