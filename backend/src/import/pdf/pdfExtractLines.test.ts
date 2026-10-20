import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractPdfLines, bucketByY } from './extractLines';
import { parseCibcCostcoRow } from './cibcCostcoMastercard';
import { skipUnlessPrivateFixtures } from '../../../test/helpers/privateFixtures';
import { synthPdf, synthPdfLines, type SynthPage } from '../../../test/helpers/syntheticPdf';
import {
  SYN_CIBC_A,
  SYN_CIBC_B,
  SYN_CIBC_C,
  SYN_COSTCO_R1,
  SYN_COSTCO_R2,
  SYN_COSTCO_R3,
  SYN_UNRECOGNIZED,
  SYN_WS_BROKERAGE,
} from '../../../test/helpers/syntheticStatements';

type TextItem = { str: string; transform: number[]; width: number };
const item = (str: string, x: number, y: number, width = str.length): TextItem => ({
  str,
  transform: [1, 0, 0, 1, x, y],
  width,
});

// The PRIVATE tests read Connor's real statement PDF (gitignored under
// backend/test/fixtures/pdf/) and are LOCAL-ONLY; in CI they skip with a loud
// reason. Each has a SYNTHETIC twin that renders a made-up statement to a real
// PDF at test time (test/helpers/syntheticPdf.ts) and always runs.
const backendRoot = join(__dirname, '..', '..', '..');
const fixturesDir = join(backendRoot, 'test', 'fixtures', 'pdf');
const skipNoFixtures = skipUnlessPrivateFixtures(join(fixturesDir, 'cibc-costco-2026-01-12.pdf'));

test('extractPdfLines returns lines with page numbers and y-coords', { skip: skipNoFixtures }, async () => {
  const buf = await readFile(join(fixturesDir, 'cibc-costco-2026-01-12.pdf'));
  const lines = await extractPdfLines(buf);
  assert.ok(lines.length > 50, `expected >50 lines, got ${lines.length}`);
  assert.ok(lines.every((l) => l.page >= 1), 'all pages must be >= 1');
  assert.ok(lines.every((l) => typeof l.y === 'number' && typeof l.text === 'string'));
});

test('extractPdfLines reconstructs the CIBC Costco Mastercard title on page 1', { skip: skipNoFixtures }, async () => {
  const buf = await readFile(join(fixturesDir, 'cibc-costco-2026-01-12.pdf'));
  const lines = await extractPdfLines(buf);
  const page1 = lines.filter((l) => l.page === 1);
  const hasTitle = page1.some((l) => l.text.includes('CIBC Costco Mastercard'));
  assert.ok(hasTitle, 'expected page 1 to contain "CIBC Costco Mastercard"');
});

test('extractPdfLines reconstructs a known transaction row with column gaps preserved', { skip: skipNoFixtures }, async () => {
  const buf = await readFile(join(fixturesDir, 'cibc-costco-2026-01-12.pdf'));
  const lines = await extractPdfLines(buf);
  // Dec 13 / Dec 15 / COSTCO WHOLESALE W1168 GUELPH ON / Retail and Grocery / 947.04
  const row = lines.find(
    (l) => l.text.includes('Dec 13') && l.text.includes('COSTCO') && l.text.includes('947.04')
  );
  assert.ok(row, 'expected to find the Dec 13 / 947.04 Costco row reconstructed on one line');
});

// Regression: the RBC bundle flow extracts lines once for the header, then
// re-extracts inside parseStatementFile. pdfjs detaches the input ArrayBuffer,
// so a shared view would leave the caller's Buffer unusable on the second
// pass ("Cannot perform Construct on a detached ArrayBuffer").
test('extractPdfLines can be called twice on the same Buffer', { skip: skipNoFixtures }, async () => {
  const buf = await readFile(join(fixturesDir, 'cibc-costco-2026-01-12.pdf'));
  const first = await extractPdfLines(buf);
  const second = await extractPdfLines(buf);
  assert.equal(first.length, second.length, 'second extraction must return same line count');
  assert.equal(buf.byteLength > 0, true, 'caller Buffer must still be readable');
});

// --- Synthetic twins: a made-up statement rendered to a real PDF at test time ---

const synthStatementPdf = () => synthPdf(SYN_CIBC_C);

test('extractPdfLines returns lines with page numbers and y-coords — synthetic PDF', async () => {
  const lines = await extractPdfLines(synthStatementPdf());
  assert.ok(lines.length > 20, `expected >20 lines, got ${lines.length}`);
  assert.deepEqual([...new Set(lines.map((l) => l.page))], [1, 2]);
  assert.ok(lines.every((l) => typeof l.y === 'number' && typeof l.text === 'string'));
  // Top of page first within each page (pdfjs y grows upward).
  for (const page of [1, 2]) {
    const ys = lines.filter((l) => l.page === page).map((l) => l.y);
    assert.deepEqual(ys, [...ys].sort((a, b) => b - a), `page ${page} lines out of order`);
  }
});

test('extractPdfLines reconstructs the CIBC Costco Mastercard title on page 1 — synthetic PDF', async () => {
  const lines = await extractPdfLines(synthStatementPdf());
  assert.ok(lines.filter((l) => l.page === 1).some((l) => l.text.includes('CIBC Costco Mastercard')));
});

test('extractPdfLines reconstructs a transaction row with column gaps preserved — synthetic PDF', async () => {
  const lines = await extractPdfLines(synthStatementPdf());
  const row = lines.find((l) => l.text.startsWith('Dec 14') && l.text.includes('1,204.30'));
  assert.ok(row, 'expected the Dec 14 / 1,204.30 row reconstructed on one line');
  // Each printed column survives as its own multi-space-separated cell, so the
  // CIBC row parser can split it.
  assert.deepEqual(row.text.split(/\s{2,}/), [
    'Dec 14', 'Dec 15', 'COSTCO WHOLESALE W0001', 'ANYTOWN', 'ON', 'Retail and Grocery', '1,204.30',
  ]);
  assert.deepEqual(parseCibcCostcoRow(row.text, { start: '2023-12-13', end: '2024-01-12' }, 'charges'), {
    date: '2023-12-14',
    merchantRaw: 'COSTCO WHOLESALE W0001 ANYTOWN ON',
    amount: -1204.3,
  });
});

test('extractPdfLines can be called twice on the same Buffer — synthetic PDF', async () => {
  const buf = synthStatementPdf();
  const first = await extractPdfLines(buf);
  const second = await extractPdfLines(buf);
  assert.equal(first.length, second.length, 'second extraction must return same line count');
  assert.deepEqual(first, second);
  assert.equal(buf.byteLength > 0, true, 'caller Buffer must still be readable');
});

// The parser unit tests feed synthPdfLines(...) straight to the parsers. That
// is only honest if it is what extractPdfLines produces from the same layout
// rendered to a PDF, so check every synthetic layout round-trips exactly.
const LAYOUTS: Record<string, SynthPage[]> = {
  SYN_CIBC_A, SYN_CIBC_B, SYN_CIBC_C, SYN_COSTCO_R1, SYN_COSTCO_R2, SYN_COSTCO_R3, SYN_WS_BROKERAGE, SYN_UNRECOGNIZED,
};
for (const [name, pages] of Object.entries(LAYOUTS)) {
  test(`synthPdfLines matches extractPdfLines on the rendered PDF — ${name}`, async () => {
    const extracted = await extractPdfLines(synthPdf(pages));
    const expected = synthPdfLines(pages);
    assert.deepEqual(
      extracted.map((l) => ({ page: l.page, y: l.y, text: l.text })),
      expected.map((l) => ({ page: l.page, y: l.y, text: l.text })),
    );
  });
}

// --- bucketByY: O(N log N) line grouping (issue #872, no fixtures needed) ---

test('bucketByY returns [] for empty input', () => {
  assert.deepEqual(bucketByY([]), []);
});

test('bucketByY groups items within Y_TOLERANCE onto one line', () => {
  // Three items at y=100, 100.5, 99.5 are all within tolerance (1) of each other.
  const buckets = bucketByY([item('a', 0, 100), item('b', 10, 100.5), item('c', 20, 99.5)]);
  assert.equal(buckets.length, 1, 'expected a single bucket');
  assert.equal(buckets[0].items.length, 3);
});

test('bucketByY separates items beyond Y_TOLERANCE into distinct lines', () => {
  const buckets = bucketByY([item('top', 0, 100), item('mid', 0, 80), item('bot', 0, 60)]);
  assert.equal(buckets.length, 3, 'three distinct y-bands → three buckets');
});

test('bucketByY returns buckets top-of-page first (descending y)', () => {
  // Supply out-of-order; output must be sorted by descending y regardless.
  const buckets = bucketByY([item('mid', 0, 80), item('bot', 0, 60), item('top', 0, 100)]);
  assert.deepEqual(buckets.map((b) => b.items[0].str), ['top', 'mid', 'bot']);
});

test('bucketByY scales linearly — 40k distinct y-coords parse fast (not O(N²))', () => {
  // Worst case for the old find()-in-loop code: every item on its own line.
  const N = 40_000;
  const items: TextItem[] = [];
  for (let i = 0; i < N; i++) items.push(item('x', 0, i * 10));
  const start = Date.now();
  const buckets = bucketByY(items);
  const elapsed = Date.now() - start;
  assert.equal(buckets.length, N, 'each distinct y-band is its own bucket');
  // O(N²) on 40k items would take many seconds; the linear sweep is sub-second.
  assert.ok(elapsed < 2000, `expected <2s for ${N} items, took ${elapsed}ms`);
});
