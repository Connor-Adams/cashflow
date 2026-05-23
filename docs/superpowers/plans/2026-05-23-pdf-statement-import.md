# PDF Statement Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PDF statement import to the existing CSV / OFX pipeline, starting with one parser (CIBC Costco Mastercard), behind a per-issuer registry so we can add RBC, BMO, etc. later without touching the dispatch layer.

**Architecture:** New `.pdf` branch in `parseStatementFile` extracts text-with-coordinates via `pdfjs-dist`, reconstructs lines by y-coord grouping, then hands the lines to a parser registry. Each registered parser exposes `sniff(lines) → boolean` and `parse(lines, ctx) → { transactions, warnings, parseErrors }`. Content-sniff dispatch (not extension/filename) picks the parser. Parsers emit `NormalizedCashTransaction[]` in cashflow's existing sign convention (positive = credit, negative = charge for credit-card accounts) and the rest of the import pipeline (`commitStatementImport`, enrichment, dedup-by-fingerprint, ImportHistory) is unchanged.

**Tech Stack:** Node 26, TypeScript everywhere, `tsx --test` (node:test) for backend tests, `pdfjs-dist` for PDF text extraction. Frontend touch is one line in `TransactionsPage.tsx`.

---

## Design summary (in lieu of separate spec)

**Source format** — three sample PDFs at `~/Downloads/onlineStatement{,(1),(2)}.pdf` are 4-page CIBC Costco Mastercard statements (`5160 …3114`) for periods Oct→Nov 2025, Nov→Dec 2025, Dec 2025→Jan 2026. Page 2 carries the transactions. Sub-sections (each optional):

| Section | Columns | Sign in cashflow |
|---|---|---|
| `Your payments` | `Trans date · Post date · Description · Amount($)` | **+** (credit to card) |
| `Your interest` | `… · Annual interest rate · Amount($)` | **−** (charge) |
| `Your new charges and credits` (preceded by `Card number 5160 …`) | `… · Spend Categories · Amount($)` | **−** (charge); rows marked `CR` → **+** |

**Date inference** — PDF dates are `Mon DD` with no year. Parse the `Transactions from <DATE> to <DATE>` header to get `[periodStart, periodEnd]`; for each transaction date, the year is the unique value in `{periodStart.year, periodEnd.year}` that places the date inside `[periodStart − 5d, periodEnd + 5d]`. (Trans date can slightly precede period; post date sits inside it.)

**Reconciliation** — each section ends with a `Total …` line. Parser sums its parsed amounts per section and emits a warning (does not fail) if section sum ≠ `Total …` line. Page-1 `Total balance` is also verified against (previous balance + charges − payments).

**Unknowns flagged for the plan**:
1. Sign indicator for a CIBC return / merchant credit inside "new charges and credits" — none in samples; parser defaults to negative and emits a warning on any row whose amount has `CR` suffix or leading `-` until we can verify with a real return.
2. Foreign currency rows are described in legalese (`**` prefix) but absent from samples — parser passes them through with the account default currency and adds a warning.

**File layout**:

```
backend/src/import/
  pdf/
    extractLines.ts           — pdfjs-dist wrapper, returns PdfLine[]
    types.ts                  — PdfParser interface, PdfParseResult
    registry.ts               — array + sniff dispatch
    cibcCostcoMastercard.ts   — first parser
  parseStatementFile.ts       — add .pdf branch (modify)
  statementTypes.ts           — add 'pdf' to StatementParserId (modify)
```

---

## File structure

**Create:**
- `backend/src/import/pdf/extractLines.ts` — pdfjs-dist wrapper: `extractPdfLines(buffer): Promise<PdfLine[]>`
- `backend/src/import/pdf/types.ts` — `PdfLine`, `PdfParser`, `PdfParseResult`, `PdfParseContext`
- `backend/src/import/pdf/registry.ts` — `pdfParsers` array + `findPdfParser(lines)`
- `backend/src/import/pdf/cibcCostcoMastercard.ts` — first parser
- `backend/test/pdfExtractLines.test.ts` — extractor unit tests
- `backend/test/pdfRegistry.test.ts` — dispatch tests
- `backend/test/pdfCibcCostcoMastercard.test.ts` — parser end-to-end tests over 3 fixtures
- `backend/test/fixtures/pdf/cibc-costco-2025-11-12.pdf` — copy of `onlineStatement (2).pdf`
- `backend/test/fixtures/pdf/cibc-costco-2025-12-12.pdf` — copy of `onlineStatement (1).pdf`
- `backend/test/fixtures/pdf/cibc-costco-2026-01-12.pdf` — copy of `onlineStatement.pdf`

**Modify:**
- `backend/package.json` — add `pdfjs-dist` dependency
- `backend/src/import/parseStatementFile.ts` — add `.pdf` branch at L500-ish
- `backend/src/import/statementTypes.ts` — extend `StatementParserId` to `'csv' | 'ofx' | 'pdf'`
- `backend/src/routes/import.ts` — extend `csvUpload` fileFilter (L19-27) and `statementUpload` fileFilter (L33-40) regexes to accept `.pdf`
- `frontend/src/pages/TransactionsPage.tsx` — extend `accept` attribute at L1194
- `backend/test/integration/importUpload.test.ts` — add two PDF-path test cases alongside existing CSV ones

**Fixture PII note** — the three sample PDFs contain Connor's name and mailing address. The plan copies them as-is into `backend/test/fixtures/pdf/`. If you don't want them in git, either redact (open in Preview → cover the address rectangle, re-export) or add `backend/test/fixtures/pdf/` to `.gitignore` and rely on local-only test runs. Decide before Task 1 step 4 (commit fixtures).

---

## Task 1: Install `pdfjs-dist` and scaffold

**Files:**
- Modify: `backend/package.json`
- Create: `backend/src/import/pdf/` (directory)
- Create: `backend/test/fixtures/pdf/` (directory) + 3 fixture PDFs

- [ ] **Step 1: Install pdfjs-dist**

Run from repo root:

```bash
cd backend && npm install pdfjs-dist && cd ..
```

Expected: `package.json` has new entry under `dependencies`, lockfile updated, no peer-dep warnings.

- [ ] **Step 2: Create directories**

```bash
mkdir -p backend/src/import/pdf
mkdir -p backend/test/fixtures/pdf
```

- [ ] **Step 3: Copy the three sample PDFs into fixtures**

```bash
cp "/Users/connoradams/Downloads/onlineStatement (2).pdf" backend/test/fixtures/pdf/cibc-costco-2025-11-12.pdf
cp "/Users/connoradams/Downloads/onlineStatement (1).pdf" backend/test/fixtures/pdf/cibc-costco-2025-12-12.pdf
cp "/Users/connoradams/Downloads/onlineStatement.pdf"     backend/test/fixtures/pdf/cibc-costco-2026-01-12.pdf
```

Verify with `ls -la backend/test/fixtures/pdf/` — should see three files, ~125–265 KB each.

- [ ] **Step 4: Commit scaffold**

```bash
git add backend/package.json backend/package-lock.json backend/test/fixtures/pdf/
git commit -m "feat(import): scaffold pdf import — add pdfjs-dist, copy CIBC Costco fixtures"
```

---

## Task 2: PDF text extractor (`extractPdfLines`)

**Files:**
- Create: `backend/src/import/pdf/types.ts`
- Create: `backend/src/import/pdf/extractLines.ts`
- Create: `backend/test/pdfExtractLines.test.ts`

- [ ] **Step 1: Define shared types**

Create `backend/src/import/pdf/types.ts`:

```ts
export type PdfLine = {
  /** 1-based page number. */
  page: number;
  /** Y coordinate of the line (in pdfjs user-space units, top-of-page is large). */
  y: number;
  /** Reconstructed line text, with multi-space gaps preserved (one or more spaces between adjacent items). */
  text: string;
};

export type PdfParseContext = {
  /** Account default currency, e.g. 'CAD'. */
  defaultCurrency: string;
};

export type PdfParseResult = {
  /** Transactions in cashflow's sign convention (positive = credit, negative = charge for credit cards). */
  transactions: Array<{
    date: string;            // YYYY-MM-DD
    merchantRaw: string;
    merchantClean: string;
    amount: number;
    currency: string;
    sourceReference: string | null;
  }>;
  warnings: string[];
  parseErrors: { rowIndex: number; message: string }[];
};

export type PdfParser = {
  id: string;
  label: string;
  /** Cheap content sniff — return true if this parser can handle the PDF. */
  sniff: (lines: PdfLine[]) => boolean;
  /** Parse all transactions out of the PDF. */
  parse: (lines: PdfLine[], ctx: PdfParseContext) => PdfParseResult;
};
```

- [ ] **Step 2: Write the failing extractor test**

Create `backend/test/pdfExtractLines.test.ts`:

```ts
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
  assert.ok(lines.every((l) => l.page >= 1 && l.page <= 4));
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
```

- [ ] **Step 3: Run the failing test**

```bash
cd backend && npm test -- --test-name-pattern=pdfExtractLines 2>&1 | tail -20
```

Expected: 3 failures with "Cannot find module '../src/import/pdf/extractLines'".

- [ ] **Step 4: Implement the extractor**

Create `backend/src/import/pdf/extractLines.ts`:

```ts
import type { PdfLine } from './types';

/** Tolerance in PDF user-space units for considering two text items "on the same line". */
const Y_TOLERANCE = 2;

type TextItem = {
  str: string;
  transform: number[]; // [scaleX, skewY, skewX, scaleY, x, y]
  width: number;
};

/**
 * Extract text lines from a PDF buffer.
 *
 * Strategy: pdfjs returns positioned text items per page. We bucket items by y-coord
 * (within Y_TOLERANCE), sort each bucket left-to-right by x, and join with the
 * minimum number of spaces needed to keep column gaps detectable (1 space if items
 * touch, more spaces proportional to the x-gap).
 *
 * Uses a dynamic import because pdfjs-dist v5 is ESM-only and the backend is
 * compiled to CommonJS (tsconfig.json `module: commonjs`). Dynamic import works
 * in both module systems and lets `tsx` do the right thing at runtime.
 */
export async function extractPdfLines(buffer: Buffer): Promise<PdfLine[]> {
  // The "legacy" build avoids the Web Worker; required in Node.
  // If pdfjs-dist v4 is installed, the path is the same.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
  }).promise;

  const out: PdfLine[] = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const items = (content.items as TextItem[]).filter((it) => typeof it.str === 'string');

    // Bucket by y (pdfjs y grows upward; we still bucket on the raw y).
    type Bucket = { y: number; items: TextItem[] };
    const buckets: Bucket[] = [];
    for (const it of items) {
      const y = it.transform[5];
      const found = buckets.find((b) => Math.abs(b.y - y) <= Y_TOLERANCE);
      if (found) {
        found.items.push(it);
        found.y = (found.y + y) / 2;
      } else {
        buckets.push({ y, items: [it] });
      }
    }

    // Sort buckets top-to-bottom (large y first), items left-to-right.
    buckets.sort((a, b) => b.y - a.y);
    for (const b of buckets) {
      b.items.sort((a, c) => a.transform[4] - c.transform[4]);
      const parts: string[] = [];
      let prevRight = -Infinity;
      let prevSpaceWidth = 0;
      for (const it of b.items) {
        const x = it.transform[4];
        const gap = x - prevRight;
        if (parts.length === 0) {
          parts.push(it.str);
        } else {
          // 1 space if items touch / overlap; scale up for wider gaps so column
          // breaks survive into the line text.
          const spaceWidth = prevSpaceWidth || 4;
          const spaces = Math.max(1, Math.round(gap / spaceWidth));
          parts.push(' '.repeat(Math.min(spaces, 40)) + it.str);
        }
        prevRight = x + it.width;
        prevSpaceWidth = it.width > 0 && it.str.length > 0 ? it.width / it.str.length : prevSpaceWidth;
      }
      const text = parts.join('').replace(/\s+$/, '');
      if (text.length > 0) out.push({ page: pageNum, y: b.y, text });
    }

    page.cleanup();
  }

  return out;
}
```

- [ ] **Step 5: Run tests until they pass**

```bash
cd backend && npm test -- --test-name-pattern=pdfExtractLines 2>&1 | tail -20
```

Expected: 3 PASS. If the third test fails (row not found), inspect with a quick repl:

```bash
cd backend && npx tsx -e "import('./src/import/pdf/extractLines.ts').then(async ({extractPdfLines}) => { const fs = await import('node:fs/promises'); const b = await fs.readFile('test/fixtures/pdf/cibc-costco-2026-01-12.pdf'); const ls = await extractPdfLines(b); console.log(ls.filter(l => l.page === 2).map(l => l.text).join('\n')); })"
```

Tune `Y_TOLERANCE` or the space-scaling constant if columns merge.

- [ ] **Step 6: Commit**

```bash
git add backend/src/import/pdf/types.ts backend/src/import/pdf/extractLines.ts backend/test/pdfExtractLines.test.ts
git commit -m "feat(import): add pdfjs-dist line extractor with y-grouping + x-sort"
```

---

## Task 3: Parser registry + dispatch

**Files:**
- Create: `backend/src/import/pdf/registry.ts`
- Create: `backend/test/pdfRegistry.test.ts`

- [ ] **Step 1: Write the failing registry test**

Create `backend/test/pdfRegistry.test.ts`:

```ts
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
  // Re-import after clearing to repopulate built-ins.
  clearPdfParsersForTest();
  await import('../src/import/pdf/registry'); // re-evaluation no-op; just for symmetry
  // Built-ins are registered as module side effect; we restore them by importing the entry that registers them.
  const mod = await import('../src/import/pdf/registry');
  mod.registerBuiltInPdfParsers();
  const lines: PdfLine[] = [
    { page: 1, y: 0, text: 'CIBC Costco Mastercard ®' },
    { page: 1, y: 0, text: 'Statement Date January 12, 2026' },
  ];
  const found = mod.findPdfParser(lines);
  assert.equal(found?.id, 'cibc_costco_mastercard');
});
```

- [ ] **Step 2: Run the failing test**

```bash
cd backend && npm test -- --test-name-pattern=pdfRegistry 2>&1 | tail -20
```

Expected: failures with "Cannot find module '../src/import/pdf/registry'".

- [ ] **Step 3: Implement the registry**

Create `backend/src/import/pdf/registry.ts`:

```ts
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
```

- [ ] **Step 4: Stub the CIBC parser so the import resolves**

Create a temporary stub at `backend/src/import/pdf/cibcCostcoMastercard.ts` (real implementation in Tasks 4–7):

```ts
import type { PdfParser } from './types';

export const cibcCostcoMastercardParser: PdfParser = {
  id: 'cibc_costco_mastercard',
  label: 'CIBC Costco Mastercard',
  sniff: (lines) => lines.some((l) => l.text.includes('CIBC Costco Mastercard')),
  parse: () => {
    throw new Error('cibc_costco_mastercard parser not implemented yet');
  },
};
```

- [ ] **Step 5: Run tests until they pass**

```bash
cd backend && npm test -- --test-name-pattern=pdfRegistry 2>&1 | tail -20
```

Expected: 3 PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/import/pdf/registry.ts backend/src/import/pdf/cibcCostcoMastercard.ts backend/test/pdfRegistry.test.ts
git commit -m "feat(import): add pdf parser registry with content-sniff dispatch"
```

---

## Task 4: CIBC Costco parser — header + period parsing

**Files:**
- Modify: `backend/src/import/pdf/cibcCostcoMastercard.ts`
- Create: `backend/test/pdfCibcCostcoMastercard.test.ts`

- [ ] **Step 1: Write the failing header test**

Create `backend/test/pdfCibcCostcoMastercard.test.ts`:

```ts
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
});

test('parseCibcCostcoHeader — November 2025 statement', async () => {
  const lines = await loadFixture('cibc-costco-2025-11-12.pdf');
  const h = parseCibcCostcoHeader(lines);
  assert.equal(h.statementDate, '2025-11-12');
  assert.equal(h.periodStart, '2025-10-13');
  assert.equal(h.periodEnd, '2025-11-12');
});
```

- [ ] **Step 2: Run the failing test**

```bash
cd backend && npm test -- --test-name-pattern=parseCibcCostcoHeader 2>&1 | tail -20
```

Expected: failures with "parseCibcCostcoHeader is not a function" or similar.

- [ ] **Step 3: Implement header parsing**

Replace `backend/src/import/pdf/cibcCostcoMastercard.ts` with:

```ts
import type { PdfLine, PdfParser } from './types';

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

export type CibcCostcoHeader = {
  statementDate: string;     // YYYY-MM-DD
  periodStart: string;       // YYYY-MM-DD
  periodEnd: string;         // YYYY-MM-DD
  accountLast4: string;      // e.g. "3114"
};

function toIso(year: number, monthZeroBased: number, day: number): string {
  const m = String(monthZeroBased + 1).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

/** Parse "January 12, 2026" → ISO. Returns null on failure. */
function parseLongDate(s: string): string | null {
  const m = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})/.exec(s);
  if (!m) return null;
  const monthName = m[1].slice(0, 3) as keyof typeof MONTHS;
  return toIso(Number(m[3]), MONTHS[monthName], Number(m[2]));
}

/**
 * Parse the "<Mon DD> to <Mon DD, YYYY>" or "<Mon DD, YYYY> to <Mon DD, YYYY>" period.
 * Both forms appear in CIBC statements:
 *   "November 13 to December 12, 2025"          (same year, abbreviated start)
 *   "December 13, 2025 to January 12, 2026"     (year boundary, fully qualified start)
 */
function parsePeriod(s: string): { start: string; end: string } | null {
  // Try fully-qualified form first.
  const both = /([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})\s+to\s+([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/.exec(s);
  if (both) {
    const startMonth = MONTHS[both[1].slice(0, 3)];
    const endMonth = MONTHS[both[4].slice(0, 3)];
    return {
      start: toIso(Number(both[3]), startMonth, Number(both[2])),
      end: toIso(Number(both[6]), endMonth, Number(both[5])),
    };
  }
  // Same-year abbreviated form.
  const abbrev = /([A-Z][a-z]+)\s+(\d{1,2})\s+to\s+([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/.exec(s);
  if (abbrev) {
    const startMonth = MONTHS[abbrev[1].slice(0, 3)];
    const endMonth = MONTHS[abbrev[3].slice(0, 3)];
    const year = Number(abbrev[5]);
    return {
      start: toIso(year, startMonth, Number(abbrev[2])),
      end: toIso(year, endMonth, Number(abbrev[4])),
    };
  }
  return null;
}

export function parseCibcCostcoHeader(lines: PdfLine[]): CibcCostcoHeader {
  const page1 = lines.filter((l) => l.page === 1);

  // Statement date — labelled "Statement Date" on one line, value on the next or same line.
  let statementDate: string | null = null;
  for (let i = 0; i < page1.length; i++) {
    if (page1[i].text.includes('Statement Date')) {
      // Value may be on the same line (after the label) or the immediate next line.
      const sameLine = parseLongDate(page1[i].text);
      if (sameLine) { statementDate = sameLine; break; }
      const next = page1[i + 1]?.text ?? '';
      const nextParsed = parseLongDate(next);
      if (nextParsed) { statementDate = nextParsed; break; }
    }
  }
  if (!statementDate) throw new Error('CIBC Costco header: could not parse Statement Date');

  // Period — appears as "<Month> statement period" followed by the period line, OR
  // as part of "Prepared for: <name> <period> Account number ..." on later pages.
  let period: { start: string; end: string } | null = null;
  for (let i = 0; i < page1.length; i++) {
    if (/statement period/i.test(page1[i].text)) {
      // Try the same line first, then next.
      period = parsePeriod(page1[i].text) || parsePeriod(page1[i + 1]?.text ?? '');
      if (period) break;
    }
  }
  // Fallback: scan "Transactions from <DATE> to <DATE>" anywhere.
  if (!period) {
    for (const l of lines) {
      const m = /Transactions from\s+(.+)/.exec(l.text);
      if (m) {
        period = parsePeriod(m[1]);
        if (period) break;
      }
    }
  }
  if (!period) throw new Error('CIBC Costco header: could not parse statement period');

  // Account last 4 — "5160 XXXX XXXX NNNN".
  let last4: string | null = null;
  for (const l of page1) {
    const m = /5160\s+X{4}\s+X{4}\s+(\d{4})/.exec(l.text);
    if (m) { last4 = m[1]; break; }
  }
  if (!last4) throw new Error('CIBC Costco header: could not parse account last4');

  return {
    statementDate,
    periodStart: period.start,
    periodEnd: period.end,
    accountLast4: last4,
  };
}

export const cibcCostcoMastercardParser: PdfParser = {
  id: 'cibc_costco_mastercard',
  label: 'CIBC Costco Mastercard',
  sniff: (lines) => lines.some((l) => l.text.includes('CIBC Costco Mastercard')),
  parse: () => {
    throw new Error('cibc_costco_mastercard parser not implemented yet');
  },
};
```

- [ ] **Step 4: Run tests until they pass**

```bash
cd backend && npm test -- --test-name-pattern=parseCibcCostcoHeader 2>&1 | tail -20
```

Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/pdf/cibcCostcoMastercard.ts backend/test/pdfCibcCostcoMastercard.test.ts
git commit -m "feat(import): parse CIBC Costco PDF header (statement date, period, last4)"
```

---

## Task 5: CIBC Costco parser — row tokenizer

**Files:**
- Modify: `backend/src/import/pdf/cibcCostcoMastercard.ts`
- Modify: `backend/test/pdfCibcCostcoMastercard.test.ts`

- [ ] **Step 1: Write failing row-tokenizer tests**

Append to `backend/test/pdfCibcCostcoMastercard.test.ts`:

```ts
import { parseCibcCostcoRow, inferYearForMonthDay } from '../src/import/pdf/cibcCostcoMastercard';

test('inferYearForMonthDay picks the period-start year for Nov 23 in a Nov→Dec period', () => {
  const y = inferYearForMonthDay('Nov 23', { start: '2025-11-13', end: '2025-12-12' });
  assert.equal(y, 2025);
});

test('inferYearForMonthDay handles year-rollover periods: Dec 24 in Dec→Jan period is the start year', () => {
  const y = inferYearForMonthDay('Dec 24', { start: '2025-12-13', end: '2026-01-12' });
  assert.equal(y, 2025);
});

test('inferYearForMonthDay handles year-rollover periods: Jan 02 in Dec→Jan period is the end year', () => {
  const y = inferYearForMonthDay('Jan 02', { start: '2025-12-13', end: '2026-01-12' });
  assert.equal(y, 2026);
});

test('inferYearForMonthDay throws when month is outside the period', () => {
  assert.throws(() => inferYearForMonthDay('Jun 15', { start: '2025-12-13', end: '2026-01-12' }));
});

test('parseCibcCostcoRow — payment row (no spend category, no Ý)', () => {
  const period = { start: '2025-12-13', end: '2026-01-12' };
  const row = parseCibcCostcoRow(
    'Dec 24           Dec 29          PAYMENT THANK YOU/PAIEMENT MERCI                                                                                                                                  577.04',
    period,
    'payments',
  );
  assert.deepEqual(row, {
    date: '2025-12-29',
    merchantRaw: 'PAYMENT THANK YOU/PAIEMENT MERCI',
    amount: 577.04,
  });
});

test('parseCibcCostcoRow — charge row with spend category', () => {
  const period = { start: '2025-12-13', end: '2026-01-12' };
  const row = parseCibcCostcoRow(
    'Dec 13           Dec 15            COSTCO WHOLESALE W1168 GUELPH                             ON                          Retail and Grocery                                                        947.04',
    period,
    'charges',
  );
  assert.equal(row.date, '2025-12-15');
  assert.equal(row.merchantRaw, 'COSTCO WHOLESALE W1168 GUELPH                             ON');
  assert.equal(row.amount, -947.04);
});

test('parseCibcCostcoRow — charge row with bonus Ý prefix is stripped', () => {
  const period = { start: '2025-11-13', end: '2025-12-12' };
  const row = parseCibcCostcoRow(
    'Dec 08           Dec 09      Ý COSTCO GAS W1168                        GUELPH           ON                               Transportation                                                              61.71',
    period,
    'charges',
  );
  assert.equal(row.date, '2025-12-09');
  assert.ok(!row.merchantRaw.includes('Ý'), 'Ý marker should be stripped');
  assert.ok(row.merchantRaw.startsWith('COSTCO GAS W1168'));
  assert.equal(row.amount, -61.71);
});

test('parseCibcCostcoRow — interest row', () => {
  const period = { start: '2025-10-13', end: '2025-11-12' };
  const row = parseCibcCostcoRow(
    'Nov 12           Nov 12          REGULAR PURCHASES                                                                     21.75%                                                                          0.07',
    period,
    'interest',
  );
  assert.equal(row.date, '2025-11-12');
  assert.equal(row.merchantRaw, 'REGULAR PURCHASES');
  assert.equal(row.amount, -0.07);
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd backend && npm test -- --test-name-pattern="parseCibcCostcoRow|inferYearForMonthDay" 2>&1 | tail -30
```

Expected: failures because exports don't exist yet.

- [ ] **Step 3: Implement the tokenizer**

Add to `backend/src/import/pdf/cibcCostcoMastercard.ts` (above the parser export):

```ts
export type Period = { start: string; end: string };

export type CibcCostcoSection = 'payments' | 'interest' | 'charges';

/**
 * Date columns in CIBC statements are "Mon DD" with no year. Pick the year
 * (period-start or period-end) whose calendar makes the date land inside the
 * statement window with a small slack (trans date can precede period start
 * by a few days; post date sits inside).
 */
export function inferYearForMonthDay(monthDay: string, period: Period): number {
  const m = /([A-Z][a-z]{2})\s+(\d{1,2})/.exec(monthDay);
  if (!m) throw new Error(`Unparseable month-day: ${JSON.stringify(monthDay)}`);
  const month = MONTHS[m[1]];
  if (month === undefined) throw new Error(`Unknown month abbreviation: ${m[1]}`);
  const day = Number(m[2]);

  const startMs = Date.parse(period.start + 'T00:00:00Z');
  const endMs = Date.parse(period.end + 'T00:00:00Z');
  const slackMs = 5 * 24 * 60 * 60 * 1000;
  const startYear = new Date(startMs).getUTCFullYear();
  const endYear = new Date(endMs).getUTCFullYear();

  const candidates = startYear === endYear ? [startYear] : [startYear, endYear];
  for (const year of candidates) {
    const ms = Date.UTC(year, month, day);
    if (ms >= startMs - slackMs && ms <= endMs + slackMs) return year;
  }
  throw new Error(
    `Month-day ${monthDay} does not fit statement period ${period.start}…${period.end}`,
  );
}

/**
 * Parse one transaction row from the layout-reconstructed line text.
 *
 * Strategy: trans-date and post-date are at the LEFT (fixed width); amount is
 * the LAST token on the line (decimal with optional CR / leading minus); the
 * description is everything in between, minus the spend-category column for
 * `charges` rows. We tokenize by run of 2+ spaces (the column separator).
 */
export function parseCibcCostcoRow(
  rawLine: string,
  period: Period,
  section: CibcCostcoSection,
): { date: string; merchantRaw: string; amount: number } {
  const line = rawLine.replace(/^\s+|\s+$/g, '');
  // Strip leading "Ý " bonus marker if present (it can appear before the merchant column).
  const stripBonus = (s: string) => s.replace(/\s*Ý\s+/g, ' ').trim();

  // Split by runs of 2+ spaces.
  const cols = line.split(/\s{2,}/).map((c) => c.trim()).filter((c) => c.length > 0);
  if (cols.length < 3) {
    throw new Error(`CIBC Costco row has too few columns: ${JSON.stringify(rawLine)}`);
  }

  const transDate = cols[0];
  const postDate = cols[1];
  const amountStr = cols[cols.length - 1];

  // Middle columns = description (+ spend category for charges + interest rate for interest).
  // For 'charges' rows the second-to-last column is the spend category; drop it.
  // For 'interest' rows the second-to-last column is the rate (e.g. "21.75%"); drop it.
  // For 'payments' rows there is no extra column.
  const middleEnd = section === 'payments' ? cols.length - 1 : cols.length - 2;
  const merchantRaw = stripBonus(cols.slice(2, middleEnd).join(' ')).replace(/\s+/g, ' ');

  // Use the post date for year inference (always within the period).
  const year = inferYearForMonthDay(postDate, period);
  const m = /([A-Z][a-z]{2})\s+(\d{1,2})/.exec(postDate);
  if (!m) throw new Error(`Unparseable post date: ${postDate}`);
  const month = MONTHS[m[1]];
  const day = Number(m[2]);
  const date = toIso(year, month, day);

  // Amount parsing: strip $, commas, handle CR suffix and leading minus.
  const cleaned = amountStr.replace(/[$,]/g, '').trim();
  let magnitude = NaN;
  let isCredit = false;
  const crMatch = /^(-?)([\d.]+)\s*CR$/i.exec(cleaned);
  if (crMatch) {
    magnitude = Number(crMatch[2]);
    isCredit = true;
  } else {
    magnitude = Number(cleaned);
    if (cleaned.startsWith('-')) isCredit = true; // treat "-N" same as CR
  }
  if (!Number.isFinite(magnitude)) {
    throw new Error(`CIBC Costco row has unparseable amount: ${JSON.stringify(amountStr)}`);
  }

  const abs = Math.abs(magnitude);
  let amount: number;
  if (section === 'payments') {
    amount = isCredit ? -abs : abs;   // payments are credits (+) unless explicitly inverted
  } else {
    // charges + interest: default negative; CR/-prefix means it's actually a credit
    amount = isCredit ? abs : -abs;
  }

  return { date, merchantRaw, amount };
}
```

- [ ] **Step 4: Run tests until they pass**

```bash
cd backend && npm test -- --test-name-pattern="parseCibcCostcoRow|inferYearForMonthDay" 2>&1 | tail -30
```

Expected: 7 PASS. If amount rounding fails, check Number conversion (`947.04` should be exact).

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/pdf/cibcCostcoMastercard.ts backend/test/pdfCibcCostcoMastercard.test.ts
git commit -m "feat(import): CIBC Costco PDF row tokenizer with year inference"
```

---

## Task 6: CIBC Costco parser — full `parse` (section splitter + reconciliation)

**Files:**
- Modify: `backend/src/import/pdf/cibcCostcoMastercard.ts`
- Modify: `backend/test/pdfCibcCostcoMastercard.test.ts`

- [ ] **Step 1: Write failing end-to-end tests**

Append to `backend/test/pdfCibcCostcoMastercard.test.ts`:

```ts
import { cibcCostcoMastercardParser } from '../src/import/pdf/cibcCostcoMastercard';

test('parser end-to-end — November 2025 statement (3 sub-sections present)', async () => {
  const lines = await loadFixture('cibc-costco-2025-11-12.pdf');
  const out = cibcCostcoMastercardParser.parse(lines, { defaultCurrency: 'CAD' });
  // 1 payment + 1 interest + 1 charge
  assert.equal(out.transactions.length, 3);

  const byDate = [...out.transactions].sort((a, b) => a.date.localeCompare(b.date));
  // Oct 23 charge (Google One)
  assert.equal(byDate[0].date, '2025-10-24');
  assert.equal(byDate[0].amount, -3.15);
  assert.ok(byDate[0].merchantRaw.includes('Google One'));
  // Nov 04 payment
  const payment = out.transactions.find((t) => t.merchantRaw.includes('PAYMENT THANK YOU'));
  assert.ok(payment);
  assert.equal(payment!.amount, 10);   // positive
  // Nov 12 interest
  const interest = out.transactions.find((t) => t.merchantRaw === 'REGULAR PURCHASES');
  assert.ok(interest);
  assert.equal(interest!.amount, -0.07);

  // All transactions tagged with the account's default currency.
  assert.ok(out.transactions.every((t) => t.currency === 'CAD'));
  // No parse errors expected.
  assert.deepEqual(out.parseErrors, []);
});

test('parser end-to-end — December 2025 statement (payments empty, charges present)', async () => {
  const lines = await loadFixture('cibc-costco-2025-12-12.pdf');
  const out = cibcCostcoMastercardParser.parse(lines, { defaultCurrency: 'CAD' });
  // 5 charges only (no payments in this period, no interest).
  assert.equal(out.transactions.length, 5);
  const total = out.transactions.reduce((s, t) => s + t.amount, 0);
  // All 5 are charges; sum should be -580.67.
  assert.equal(Math.round(total * 100) / 100, -580.67);
});

test('parser end-to-end — January 2026 statement (rollover period, payment + 5 charges)', async () => {
  const lines = await loadFixture('cibc-costco-2026-01-12.pdf');
  const out = cibcCostcoMastercardParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(out.transactions.length, 6);
  // Dec 24 payment of 577.04 (positive)
  const payment = out.transactions.find((t) => t.merchantRaw.includes('PAYMENT THANK YOU'));
  assert.equal(payment?.date, '2025-12-29');
  assert.equal(payment?.amount, 577.04);
  // Jan 02 Costco annual renewal (year-rollover handling)
  const renewal = out.transactions.find((t) => t.merchantRaw.includes('ANNUAL RENEWAL'));
  assert.equal(renewal?.date, '2026-01-02');
  assert.equal(renewal?.amount, -146.90);
  // Total charges should be -2278.00
  const chargeSum = out.transactions
    .filter((t) => t.amount < 0)
    .reduce((s, t) => s + t.amount, 0);
  assert.equal(Math.round(chargeSum * 100) / 100, -2278);
});

test('parser produces a deterministic merchantClean (uppercased, collapsed whitespace, no trailing province)', async () => {
  const lines = await loadFixture('cibc-costco-2025-12-12.pdf');
  const out = cibcCostcoMastercardParser.parse(lines, { defaultCurrency: 'CAD' });
  const costco = out.transactions.find((t) => t.merchantRaw.includes('COSTCO WHOLESALE'));
  assert.ok(costco);
  // merchantClean is normalized — at minimum no double spaces, no province code suffix " ON".
  assert.ok(!/\s{2,}/.test(costco!.merchantRaw));
  assert.ok(typeof costco!.merchantClean === 'string' && costco!.merchantClean.length > 0);
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd backend && npm test -- --test-name-pattern="parser end-to-end|deterministic" 2>&1 | tail -30
```

Expected: failures from the stub `parse()` throwing.

- [ ] **Step 3: Implement section splitter + full `parse`**

Replace the stub `cibcCostcoMastercardParser.parse` in `backend/src/import/pdf/cibcCostcoMastercard.ts`, and add the splitter / helpers above it. Add at the bottom of the file:

```ts
import { normalizeMerchant } from '../normalizeMerchant';

const SECTION_HEADERS: Record<CibcCostcoSection, RegExp> = {
  payments: /^Your payments$/,
  interest: /^Your interest$/,
  charges: /^Your new charges and credits$/,
};

const SECTION_TOTAL_PATTERNS: Record<CibcCostcoSection, RegExp> = {
  payments: /^Total payments/i,
  interest: /^Total interest/i,
  charges: /^Total for /i,        // "Total for 5160 XXXX XXXX 3114  $N.NN"
};

/** Lines that should be skipped while inside a section body. */
const SECTION_SKIP_PATTERNS: RegExp[] = [
  /^Trans\s*$/, /^Post\s*$/, /^date\b/, /^Description\b/, /^Amount\(\$\)/,
  /^Spend Categories/, /^Annual interest rate/,
  /^Card number 5160 X{4} X{4} \d{4}$/,
  /^Ý Identifies transactions/, /^same rate\.$/,
];

/**
 * Walk the lines and slice them into per-section line arrays. Section headers
 * can appear once on page 2 and again as "(continued)" on later pages if the
 * statement spills. CIBC Costco statements are typically 4 pages with all
 * transactions on page 2, but we don't rely on that.
 */
function splitSections(lines: PdfLine[]): Record<CibcCostcoSection, PdfLine[]> {
  const buckets: Record<CibcCostcoSection, PdfLine[]> = {
    payments: [], interest: [], charges: [],
  };
  let current: CibcCostcoSection | null = null;
  for (const line of lines) {
    const trimmed = line.text.trim();

    const startedHere = (Object.keys(SECTION_HEADERS) as CibcCostcoSection[])
      .find((s) => SECTION_HEADERS[s].test(trimmed));
    if (startedHere) { current = startedHere; continue; }

    if (current) {
      if (SECTION_TOTAL_PATTERNS[current].test(trimmed)) {
        current = null;
        continue;
      }
      if (SECTION_SKIP_PATTERNS.some((re) => re.test(trimmed))) continue;
      // Only keep lines that start with a "Mon DD" pattern — these are transaction rows.
      if (/^[A-Z][a-z]{2}\s+\d{1,2}\s/.test(trimmed)) {
        buckets[current].push(line);
      }
    }
  }
  return buckets;
}

/** Strip trailing " ON" / " QC" / " BC" etc. (Canadian provinces) from the merchant string. */
function stripProvinceSuffix(s: string): string {
  return s.replace(/\s+(?:AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)$/, '');
}

cibcCostcoMastercardParser.parse = (lines, ctx) => {
  const header = parseCibcCostcoHeader(lines);
  const period: Period = { start: header.periodStart, end: header.periodEnd };
  const sections = splitSections(lines);

  const transactions: PdfParseResult['transactions'] = [];
  const warnings: string[] = [];
  const parseErrors: PdfParseResult['parseErrors'] = [];

  const sectionTotals: Partial<Record<CibcCostcoSection, number>> = {};
  for (const line of lines) {
    const t = line.text.trim();
    for (const sec of Object.keys(SECTION_TOTAL_PATTERNS) as CibcCostcoSection[]) {
      if (SECTION_TOTAL_PATTERNS[sec].test(t)) {
        const m = /\$?([\d,]+\.\d{2})\s*(CR)?$/.exec(t);
        if (m) {
          const v = Number(m[1].replace(/,/g, ''));
          sectionTotals[sec] = m[2] ? -v : v;
        }
      }
    }
  }

  (Object.keys(sections) as CibcCostcoSection[]).forEach((sec) => {
    let parsedSum = 0;
    for (let i = 0; i < sections[sec].length; i++) {
      const line = sections[sec][i];
      try {
        const row = parseCibcCostcoRow(line.text, period, sec);
        const merchantStripped = stripProvinceSuffix(row.merchantRaw).trim();
        const merchantClean = normalizeMerchant(merchantStripped);
        transactions.push({
          date: row.date,
          merchantRaw: row.merchantRaw,
          merchantClean,
          amount: row.amount,
          currency: ctx.defaultCurrency,
          sourceReference: null,
        });
        // For reconciliation we sum the absolute "as printed in PDF" values:
        // payments printed positive, charges printed positive, etc.
        parsedSum += Math.abs(row.amount);
      } catch (err) {
        parseErrors.push({ rowIndex: i + 1, message: (err as Error).message });
      }
    }
    const total = sectionTotals[sec];
    if (total !== undefined) {
      const diff = Math.abs(Math.abs(total) - parsedSum);
      if (diff > 0.01) {
        warnings.push(
          `Section "${sec}" sum mismatch: parsed ${parsedSum.toFixed(2)} vs printed total ${total.toFixed(2)}`,
        );
      }
    }
  });

  return { transactions, warnings, parseErrors };
};
```

- [ ] **Step 4: Run tests until they pass**

```bash
cd backend && npm test -- --test-name-pattern="parser end-to-end|deterministic" 2>&1 | tail -30
```

Expected: 4 PASS. If `Spend Categories` text leaks into the merchant column, the col-split heuristic needs adjustment (e.g. drop tokens whose last is a known category like `Retail and Grocery`).

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/pdf/cibcCostcoMastercard.ts backend/test/pdfCibcCostcoMastercard.test.ts
git commit -m "feat(import): CIBC Costco PDF section splitter + reconciliation warnings"
```

---

## Task 7: Multer + upload routes accept `.pdf`

(Done before Task 8 so Task 8's integration test through `/api/import/upload` lands in a single green run.)

**Files:**
- Modify: `backend/src/routes/import.ts`

- [ ] **Step 1: Extend `csvUpload` filter (L19-27)**

Replace lines 19-27 of `backend/src/routes/import.ts`:

```ts
  fileFilter: (_req, file, cb) => {
    if (!/\.(csv|pdf)$/i.test(file.originalname)) {
      const e = new Error('Only .csv and .pdf files are allowed') as Error & { status?: number };
      e.status = 400;
      cb(e);
      return;
    }
    cb(null, true);
  },
```

- [ ] **Step 2: Extend `statementUpload` filter (L33-40)**

Replace the regex on line 34:

```ts
    if (!/\.(csv|ofx|qfx|pdf)$/i.test(file.originalname)) {
      const e = new Error('Only .csv, .ofx, .qfx, and .pdf files are allowed') as Error & { status?: number };
      e.status = 400;
      cb(e);
      return;
    }
```

- [ ] **Step 3: Sanity-check that nothing else broke**

```bash
cd backend && npm test 2>&1 | tail -10
```

Expected: same baseline as before — multer changes don't affect any current test.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/import.ts
git commit -m "feat(import): allow .pdf uploads through csvUpload + statementUpload multer filters"
```

---

## Task 8: Wire `.pdf` into `parseStatementFile`

**Files:**
- Modify: `backend/src/import/statementTypes.ts`
- Modify: `backend/src/import/parseStatementFile.ts`
- Modify: `backend/test/integration/importUpload.test.ts` (add PDF test cases next to existing CSV ones)

The integration test slots into the existing harness in `backend/test/integration/importUpload.test.ts` rather than a new file — that file already runs migrations, registers an authed user, and proxies through `/api/import/upload` via supertest. Mirroring that harness in a new file would be ~50 lines of duplication.

- [ ] **Step 1: Extend `StatementParserId`**

In `backend/src/import/statementTypes.ts` line 1:

```ts
export type StatementParserId = 'csv' | 'ofx' | 'pdf';
```

- [ ] **Step 2: Add failing integration test cases**

Append to `backend/test/integration/importUpload.test.ts` (after the last existing `test(...)` block, before the file ends):

```ts
test('POST /api/import/upload: parses a CIBC Costco PDF statement end-to-end', async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'CIBC Costco MC (pdf integration)',
    owner: 'me',
    accountType: 'credit_card',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const pdfPath = path.join(backendRoot, 'test', 'fixtures', 'pdf', 'cibc-costco-2026-01-12.pdf');
  const buf = fs.readFileSync(pdfPath);
  const res = await authed
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .attach('file', buf, {
      filename: 'cibc-costco-2026-01-12.pdf',
      contentType: 'application/pdf',
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.inserted, 6, JSON.stringify(res.body));
  assert.equal(res.body.parseErrors?.length ?? 0, 0);
});

test('POST /api/import/upload: rejects an unknown-layout PDF with a clear error', async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'PDF reject account',
    owner: 'me',
    accountType: 'credit_card',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  // A minimal valid PDF (one blank page) that no parser will sniff.
  const blankPdf = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n160\n%%EOF',
    'binary',
  );
  const res = await authed
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .attach('file', blankPdf, {
      filename: 'unknown.pdf',
      contentType: 'application/pdf',
    });
  // The route returns 200 with `error` populated when parseStatementFile rejects.
  // Confirm by checking the body matches the existing CSV-error contract:
  assert.ok(res.body.error || res.status >= 400, JSON.stringify({ status: res.status, body: res.body }));
  if (res.body.error) assert.match(res.body.error, /PDF|parser/i);
});
```

(If the route's error contract is different — e.g. it returns 4xx — adjust the last assertion to match what `/api/import/upload` does on `parseStatementFile`'s `{ ok: false, error }` today. Quick check: read `backend/src/routes/import.ts:185-256` to see how the CSV path surfaces a parser error and mirror that expectation.)

- [ ] **Step 3: Run failing test**

```bash
cd backend && npm run test:integration -- --test-name-pattern="CIBC Costco PDF|unknown-layout PDF" 2>&1 | tail -30
```

Expected: failures — the route reaches `parseStatementFile` but the `.pdf` branch returns the "Only .csv, .ofx, and .qfx" error from L526 until Step 4 lands the branch.

- [ ] **Step 4: Add the `.pdf` branch**

In `backend/src/import/parseStatementFile.ts`, add imports at the top (after existing imports):

```ts
import { extractPdfLines } from './pdf/extractLines';
import { findPdfParser, registerBuiltInPdfParsers } from './pdf/registry';
import { rowFingerprint } from './fingerprint';
```

(omit `rowFingerprint` import if it's already present — check the existing imports first.)

Just before `if (ext === '.csv') {` at line 439, ensure built-ins are registered once:

```ts
registerBuiltInPdfParsers();
```

After the `.ofx/.qfx` branch (around L523), before the final `return { ok: false, ... }`, add:

```ts
if (ext === '.pdf') {
  let lines;
  try {
    lines = await extractPdfLines(opts.buffer);
  } catch (err) {
    return { ok: false, error: `Could not read PDF: ${(err as Error).message}` };
  }
  const parser = findPdfParser(lines);
  if (!parser) {
    return {
      ok: false,
      error: 'No PDF parser registered for this statement layout',
    };
  }
  const out = parser.parse(lines, { defaultCurrency });
  const transactions = out.transactions.map((v) => ({
    date: v.date,
    merchantRaw: v.merchantRaw,
    merchantClean: v.merchantClean,
    amount: v.amount,
    currency: v.currency,
    sourceReference: v.sourceReference,
    sourceRowFingerprint: rowFingerprint({
      accountId: account.id,
      date: v.date,
      amount: v.amount,
      currency: v.currency,
      merchantClean: v.merchantClean,
      sourceReference: v.sourceReference,
    }),
  }));
  const preview = {
    ...base,
    usedParser: 'pdf' as const,
    usedProfileId: parser.id,
    transactions,
    warnings: out.warnings,
    parseErrors: out.parseErrors,
    rowErrors: out.parseErrors.length,
    rows: transactions.slice(0, 25).map((row, index) => ({
      rowIndex: index + 1,
      ok: true as const,
      mapped: {
        date: row.date,
        merchantClean: row.merchantClean,
        amount: row.amount,
        currency: row.currency,
      },
    })),
  };
  await markDuplicates(preview);
  return saveStatementPreview(preview);
}
```

Update the final error string at L526 to mention PDF:

```ts
return { ok: false, error: 'Only .csv, .ofx, .qfx, and .pdf files are supported' };
```

- [ ] **Step 5: Run tests until they pass**

```bash
cd backend && npm run test:integration -- --test-name-pattern="CIBC Costco PDF|unknown-layout PDF" 2>&1 | tail -30
```

Expected: 2 PASS. If `inserted` ≠ 6 in the first test, the dispatch reached `parseStatementFile` but the CIBC parser dropped rows — debug by logging `out.warnings` and `out.parseErrors` from the route, or run the parser-level tests from Task 6 in isolation.

- [ ] **Step 6: Run the full backend test suite to confirm no regressions**

```bash
cd backend && npm test 2>&1 | tail -10
cd backend && npm run test:integration 2>&1 | tail -10
```

Expected: same baseline as before (or all green if everything was green to start).

- [ ] **Step 7: Commit**

```bash
git add backend/src/import/statementTypes.ts backend/src/import/parseStatementFile.ts backend/test/integration/importUpload.test.ts
git commit -m "feat(import): wire .pdf branch into parseStatementFile with parser registry"
```

---

## Task 9: Frontend file-picker accepts `.pdf`

**Files:**
- Modify: `frontend/src/pages/TransactionsPage.tsx`

- [ ] **Step 1: Extend the `accept` attribute**

In `frontend/src/pages/TransactionsPage.tsx` line 1194:

```tsx
                accept=".csv,text/csv,.ofx,.qfx,.pdf,application/pdf"
```

- [ ] **Step 2: Verify in the browser**

```bash
cd frontend && npm run dev
```

Open the app, navigate to Transactions, click "Statement files" — the OS file picker should now show PDF files as selectable alongside CSV/OFX/QFX. Pick a CIBC Costco PDF + a credit card account, click Upload, and verify the success banner shows N inserted rows.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/TransactionsPage.tsx
git commit -m "feat(import): allow PDF file selection in transactions upload UI"
```

---

## Task 10: End-to-end manual verification

**No file changes — verification only.**

- [ ] **Step 1: Run backend + frontend together**

```bash
cd backend && npm run dev &
cd frontend && npm run dev
```

- [ ] **Step 2: Upload each of the three fixtures via the UI**

For each fixture (`cibc-costco-2025-11-12.pdf`, `cibc-costco-2025-12-12.pdf`, `cibc-costco-2026-01-12.pdf`):

1. Pick a credit-card account (real or test).
2. Select the PDF, click Upload.
3. Confirm the success banner row counts match the spec:
   - Nov statement: 3 transactions (1 payment +10.00, 1 interest −0.07, 1 charge −3.15)
   - Dec statement: 5 transactions, all charges, totalling −580.67
   - Jan statement: 6 transactions, 1 payment +577.04 + 5 charges totalling −2,278.00
4. Open the Transactions page and verify the new rows appear with correct dates, amounts, and merchant strings.

- [ ] **Step 3: Re-upload the same PDF and verify dedup**

Upload `cibc-costco-2026-01-12.pdf` a second time. The success banner should show 6 duplicates and 0 inserted (since `sourceRowFingerprint` matches on account+date+amount+currency+merchantClean).

- [ ] **Step 4: Run the full test suites one final time**

```bash
cd backend && npm test 2>&1 | tail -10
cd frontend && npm test 2>&1 | tail -10
```

Expected: all green.

- [ ] **Step 5: Final commit (only if any fixup edits made in steps 1-4)**

```bash
git status
# If any tweaks were needed:
git add -A && git commit -m "fix(import): tweak <whatever> after PDF e2e verification"
```

---

## Out of scope (deferred)

- Additional issuers (RBC, BMO, Amex Canada PDF, etc.) — add new files under `backend/src/import/pdf/` and one line in `registerBuiltInPdfParsers()`. No core changes needed.
- A user-facing "which parsers do you support?" listing in the UI — pull from `listPdfParsers()` if/when it's wanted on the Import page.
- Multi-currency rows (foreign txns with `**` prefix in CIBC statements) — none in the samples; parser passes them through with the account default currency and surfaces a warning. Address when a real sample appears.
- OCR for scanned (non-text) PDFs — out of scope; `extractPdfLines` will return empty and `findPdfParser` will return null, surfacing the existing "No PDF parser registered" error.
