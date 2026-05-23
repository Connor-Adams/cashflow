import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractPdfLines } from '../src/import/pdf/extractLines';
import { parseCibcCostcoHeader } from '../src/import/pdf/cibcCostcoMastercard';

const fixturesDir = join(__dirname, 'fixtures', 'pdf');

async function loadFixture(name: string) {
  const buf = await readFile(join(fixturesDir, name));
  return extractPdfLines(buf);
}

test('parseCibcCostcoHeader — January 2026 statement', async () => {
  const lines = await loadFixture('cibc-costco-2026-01-12.pdf');
  const h = parseCibcCostcoHeader(lines);
  assert.equal(h.statementDate, '2026-01-12');
  assert.equal(h.periodStart, '2025-12-13');
  assert.equal(h.periodEnd, '2026-01-12');
  assert.equal(h.accountLast4, '3114');
});

test('parseCibcCostcoHeader — December 2025 statement', async () => {
  const lines = await loadFixture('cibc-costco-2025-12-12.pdf');
  const h = parseCibcCostcoHeader(lines);
  assert.equal(h.statementDate, '2025-12-12');
  assert.equal(h.periodStart, '2025-11-13');
  assert.equal(h.periodEnd, '2025-12-12');
  assert.equal(h.accountLast4, '3114');
});

test('parseCibcCostcoHeader — November 2025 statement', async () => {
  const lines = await loadFixture('cibc-costco-2025-11-12.pdf');
  const h = parseCibcCostcoHeader(lines);
  assert.equal(h.statementDate, '2025-11-12');
  assert.equal(h.periodStart, '2025-10-13');
  assert.equal(h.periodEnd, '2025-11-12');
  assert.equal(h.accountLast4, '3114');
});
