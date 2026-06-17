import type { PdfLine, PdfParser } from './types';
import {
  createAmexParser,
  parseAmexAmount,
  parseAmexHeaderLine,
  type AmexHeaderBase,
} from './amexCommon';

const SNIFF_RE = /American Express.*Card\b/;

const PRODUCT_RE = /^\s*(American Express\S*\s+.+?Card)\b/;

export type AmexHeader = AmexHeaderBase & {
  productLabel: string;
};

function detectProductLabel(lines: PdfLine[]): string {
  for (const l of lines.filter((l) => l.page === 1)) {
    const m = PRODUCT_RE.exec(l.text.trim());
    if (m) return m[1].replace(/[®™*]/g, '').replace(/\s+/g, ' ').trim();
  }
  return 'American Express Card';
}

export function parseAmexHeader(lines: PdfLine[]): AmexHeader {
  const base = parseAmexHeaderLine(lines);
  if (!base) throw new Error('Amex header: could not find account/period line');
  return { ...base, productLabel: detectProductLabel(lines) };
}

/**
 * Parse FX original amount — handles both anglo ("1,234.56") and European
 * ("19,00", "1.234,56") number formats. Detect the European decimal comma
 * before stripping commas, which would otherwise read "19,00" as 1900 (100x)
 * or "1.234,56" as 1.23456. Mirrors parseRawNumber in import/mapRow.ts: a
 * trailing comma group of 1-2 digits can't be a thousands group (those are
 * exactly 3 digits).
 */
function parseFxAmount(s: string): number {
  let trimmed = s.trim();
  const lastComma = trimmed.lastIndexOf(',');
  const lastDot = trimmed.lastIndexOf('.');
  const europeanDecimal =
    lastComma !== -1 &&
    (lastDot !== -1 ? lastComma > lastDot : /,\d{1,2}$/.test(trimmed));
  if (europeanDecimal) {
    trimmed = trimmed.replace(/\./g, '');
    const i = trimmed.lastIndexOf(',');
    trimmed = `${trimmed.slice(0, i)}.${trimmed.slice(i + 1)}`;
    return Number(trimmed);
  }
  return parseAmexAmount(trimmed);
}

export const amexParser: PdfParser = createAmexParser({
  id: 'amex',
  label: 'American Express',
  sniff: (lines) => lines.some((l) => SNIFF_RE.test(l.text)),
  resolveHeader: parseAmexHeader,
  productLabel: detectProductLabel,
  parseFxAmount,
});
