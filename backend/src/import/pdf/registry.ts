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

/** Test-only — wipe the registry and reset the built-ins guard. Production code never calls this. */
export function clearPdfParsersForTest(): void {
  parsers.length = 0;
  builtInsRegistered = false;
}

/**
 * Register the built-in PDF parsers. Idempotent via a one-shot guard.
 * Tests can re-register after `clearPdfParsersForTest()`. Production code
 * calls this once when the .pdf branch of `parseStatementFile` is invoked.
 */
let builtInsRegistered = false;
export function registerBuiltInPdfParsers(): void {
  if (builtInsRegistered) return;
  // Lazy require avoids circular module init with extractLines/pdfjs-dist.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { cibcCostcoMastercardParser } = require('./cibcCostcoMastercard');
  const { rbcPersonalBankingParser } = require('./rbcPersonalBanking');
  const { rbcVisaParser } = require('./rbcVisa');
  const { rbcCreditLineParser } = require('./rbcCreditLine');
  const { rbcInvestmentParser } = require('./rbcInvestment');
  /* eslint-enable @typescript-eslint/no-require-imports */
  registerPdfParser(cibcCostcoMastercardParser);
  registerPdfParser(rbcPersonalBankingParser);
  registerPdfParser(rbcVisaParser);
  registerPdfParser(rbcCreditLineParser);
  registerPdfParser(rbcInvestmentParser);
  builtInsRegistered = true;
}
