import type { PdfLine, PdfParser } from './types';
import {
  createAmexParser,
  parseAmexAmount,
  parseAmexHeaderLine,
  type AmexHeaderBase,
} from './amexCommon';

const SNIFF_RE = /American Express®.*Reserve Card/;

export type AmexReserveHeader = AmexHeaderBase;

export function parseAmexReserveHeader(lines: PdfLine[]): AmexReserveHeader {
  const base = parseAmexHeaderLine(lines);
  if (!base) throw new Error('Amex Reserve header: could not find account/period line');
  return base;
}

/** Parse FX original amount — handles European comma-as-decimal (e.g. "19,00" = 19.00). */
function parseFxAmount(s: string): number {
  const trimmed = s.trim();
  if (!trimmed.includes('.') && /,\d{2}$/.test(trimmed)) {
    return Number(trimmed.replace(',', '.'));
  }
  return parseAmexAmount(trimmed);
}

export const amexReserveParser: PdfParser = createAmexParser({
  id: 'amex_reserve',
  label: 'American Express Aeroplan Reserve',
  sniff: (lines) => lines.some((l) => SNIFF_RE.test(l.text)),
  resolveHeader: parseAmexReserveHeader,
  productLabel: () => 'American Express Aeroplan Reserve Card',
  parseFxAmount,
  txnDate: (row) => row.postDate,
});
