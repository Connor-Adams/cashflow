import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractPdfLines } from '../src/import/pdf/extractLines';

const fixturesDir = join(__dirname, 'fixtures', 'pdf');

test('extractPdfLines returns lines with page numbers and y-coords', async () => {
  const buf = await readFile(join(fixturesDir, 'cibc-costco-2026-01-12.pdf'));
  const lines = await extractPdfLines(buf);
  assert.ok(lines.length > 50, `expected >50 lines, got ${lines.length}`);
  assert.ok(lines.every((l) => l.page >= 1), 'all pages must be >= 1');
  assert.ok(lines.every((l) => typeof l.y === 'number' && typeof l.text === 'string'));
});

test('extractPdfLines reconstructs the CIBC Costco Mastercard title on page 1', async () => {
  const buf = await readFile(join(fixturesDir, 'cibc-costco-2026-01-12.pdf'));
  const lines = await extractPdfLines(buf);
  const page1 = lines.filter((l) => l.page === 1);
  const hasTitle = page1.some((l) => l.text.includes('CIBC Costco Mastercard'));
  assert.ok(hasTitle, 'expected page 1 to contain "CIBC Costco Mastercard"');
});

test('extractPdfLines reconstructs a known transaction row with column gaps preserved', async () => {
  const buf = await readFile(join(fixturesDir, 'cibc-costco-2026-01-12.pdf'));
  const lines = await extractPdfLines(buf);
  // Dec 13 / Dec 15 / COSTCO WHOLESALE W1168 GUELPH ON / Retail and Grocery / 947.04
  const row = lines.find(
    (l) => l.text.includes('Dec 13') && l.text.includes('COSTCO') && l.text.includes('947.04')
  );
  assert.ok(row, 'expected to find the Dec 13 / 947.04 Costco row reconstructed on one line');
});
