import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPdfParser, registerPdfParser, clearPdfParsersForTest } from '../src/import/pdf/registry';
import type { PdfLine, PdfParser } from '../src/import/pdf/types';

function mkLine(text: string): PdfLine {
  return { page: 1, y: 0, text };
}

test('findPdfParser returns null when no parser matches', () => {
  clearPdfParsersForTest();
  const fake: PdfParser = {
    id: 'fake',
    label: 'Fake',
    sniff: (ls) => ls.some((l) => l.text.includes('FAKE BANK')),
    parse: () => ({ transactions: [], warnings: [], parseErrors: [] }),
  };
  registerPdfParser(fake);
  const result = findPdfParser([mkLine('Hello world')]);
  assert.equal(result, null);
});

test('findPdfParser returns the first matching parser', () => {
  clearPdfParsersForTest();
  const a: PdfParser = {
    id: 'a',
    label: 'A',
    sniff: (ls) => ls.some((l) => l.text.includes('FOO')),
    parse: () => ({ transactions: [], warnings: [], parseErrors: [] }),
  };
  const b: PdfParser = {
    id: 'b',
    label: 'B',
    sniff: (ls) => ls.some((l) => l.text.includes('FOO')),
    parse: () => ({ transactions: [], warnings: [], parseErrors: [] }),
  };
  registerPdfParser(a);
  registerPdfParser(b);
  const result = findPdfParser([mkLine('FOO bar')]);
  assert.equal(result?.id, 'a');
});

test('built-in parsers include CIBC Costco Mastercard', async () => {
  clearPdfParsersForTest();
  const mod = await import('../src/import/pdf/registry');
  mod.registerBuiltInPdfParsers();
  const lines: PdfLine[] = [
    { page: 1, y: 0, text: 'CIBC Costco Mastercard ®' },
    { page: 1, y: 0, text: 'Statement Date January 12, 2026' },
  ];
  const found = mod.findPdfParser(lines);
  assert.equal(found?.id, 'cibc_costco_mastercard');
});
