# Wealthsimple PDF Statement Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse Wealthsimple credit-card and brokerage monthly statement PDFs into cashflow's existing `Transaction` / `InvestmentActivity` / `HoldingSnapshot` primitives, deduping against already-imported WS CSV data, then backfill 187 historical statements into prod.

**Architecture:** Two new `PdfParser`s registered in the existing `pdf/registry.ts`, emitting `PdfStatementHeader` + activities + holdings + transactions. Cross-source dedup is wired by extending `PdfParser` with two optional declarations (`crossSourceDedup`, `holdingFingerprint`) that `parseStatementFile`'s `.pdf` branch honors. The reusable feature flows through the existing `/upload-pdf-bundle` route + `importPdfBundleFile` (body-header account resolution). The 187-file backfill is a script that resolves accounts from the `<acctno>_<period>_<TYPE>.pdf` filename (so it lands on the same `Account.shortCode` the CSV importers used) and reuses `parseStatementFile` + `commitStatementImport`.

**Tech Stack:** TypeScript (CommonJS), `pdfjs-dist` (positioned-text extraction via `extractPdfLines`), Sequelize, `node:test` + `node:assert/strict` (run via `tsx`), yarn.

**Spec:** `docs/superpowers/specs/2026-06-02-wealthsimple-pdf-import-design.md`

---

## File Structure

**Create:**
- `backend/src/import/pdf/wealthsimpleActivityCodes.ts` — shared WS transaction-code → `activityType` map (one responsibility: the taxonomy).
- `backend/src/import/pdf/wealthsimpleCreditCard.ts` — credit-card `PdfParser`.
- `backend/src/import/pdf/wealthsimpleBrokerage.ts` — brokerage `PdfParser` (header + holdings + activities).
- `backend/scripts/dumpPdfLines.ts` — dev tool: dump `extractPdfLines` output for a PDF, to ground test fixtures in reality.
- `backend/scripts/importWealthsimplePdfs.ts` — filename-driven backfill script (dry-run + commit modes).
- `backend/test/pdfWealthsimpleCreditCard.test.ts`, `backend/test/pdfWealthsimpleBrokerage.test.ts` — parser tests.

**Modify:**
- `backend/src/import/pdf/types.ts` — add optional `crossSourceDedup` + `holdingFingerprint` to `PdfParser`.
- `backend/src/import/parseStatementFile.ts` — `.pdf` branch honors the parser's dedup declarations.
- `backend/src/import/pdf/registry.ts` — register the two WS parsers.
- `backend/src/import/runImport.ts` — add WS product labels to `PDF_ACCOUNT_TEMPLATES`.
- `backend/test/pdfRegistry.test.ts` — assert WS parsers are registered + sniffed.

---

## Task 1: Preflight — deps + real line capture

**Files:**
- Create: `backend/scripts/dumpPdfLines.ts`

- [ ] **Step 1: Install backend deps** (this worktree has none)

Run: `cd backend && yarn install --frozen-lockfile`
Expected: `node_modules/` populated; `node_modules/pdfjs-dist` and `node_modules/tsx` present.

- [ ] **Step 2: Write the line-dump dev tool**

Create `backend/scripts/dumpPdfLines.ts`:

```ts
/**
 * Dev tool — dump extractPdfLines() output for a PDF so parser fixtures match
 * what pdfjs actually produces (column gaps, y-bucket splits, wrapped rows).
 *
 * Usage: tsx scripts/dumpPdfLines.ts <path-to.pdf> [firstPage] [lastPage]
 */
import { extractPdfLines } from '../src/import/pdf/extractLines';
import fs from 'node:fs';

async function main() {
  const [file, f, l] = process.argv.slice(2);
  if (!file) throw new Error('usage: dumpPdfLines.ts <pdf> [firstPage] [lastPage]');
  const buf = fs.readFileSync(file);
  const lines = await extractPdfLines(buf);
  const lo = f ? Number(f) : 1;
  const hi = l ? Number(l) : Infinity;
  for (const ln of lines) {
    if (ln.page < lo || ln.page > hi) continue;
    process.stdout.write(`p${ln.page} y=${ln.y.toFixed(1)}  ${JSON.stringify(ln.text)}\n`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Capture representative fixtures**

Run (statements live in the additional working dir `/Users/connoradams/Downloads/monthly_pdf_statements`):

```bash
cd backend
DIR=/Users/connoradams/Downloads/monthly_pdf_statements
tsx scripts/dumpPdfLines.ts $DIR/C13BRX957CAD_2026-05_CREDIT_CARD.pdf      > /tmp/ws_cc.txt
tsx scripts/dumpPdfLines.ts $DIR/HQ6LMLTK8CAD_2025-05_BROKERAGE.pdf 1 2    > /tmp/ws_brk_cad.txt   # populated TFSA, CAD-only
tsx scripts/dumpPdfLines.ts $DIR/HQ4TLFJ02CAD_2025-12_BROKERAGE.pdf 1 3    > /tmp/ws_brk_margin.txt # margin w/ USD (pick a populated month)
tsx scripts/dumpPdfLines.ts $DIR/HQ4TLFJ02CAD_2026-04_BROKERAGE.pdf 1 2    > /tmp/ws_brk_empty.txt  # empty/zero account
```

Read each dump. These exact line strings become the `mk(...)` fixtures in the parser tests below. **When a fixture string in this plan differs from the captured text, the captured text wins** — adjust the fixture and, if needed, the tokenization, but keep the assertions.

- [ ] **Step 4: Commit the dev tool**

```bash
git add backend/scripts/dumpPdfLines.ts
git commit --no-verify -m "chore(import): add dumpPdfLines dev tool for PDF fixture capture"
```

(Use `--no-verify` throughout: husky/lint-staged is not provisioned in this worktree.)

---

## Task 2: Account-identity verification (BLOCKING GATE)

No code. Confirm the PDF-derived account ids match the `shortCode`s the CSV importers already stored, or the backfill double-counts into duplicate accounts. **Per Connor's standing rule: use the prod DB, never local sqlite.**

- [ ] **Step 1: Pull existing WS accounts from prod**

Using the prod `DATABASE_URL`, run (psql or a throwaway `tsx` query):

```sql
SELECT id, short_code, name, account_type, default_currency, entity_id
FROM accounts
WHERE name ILIKE 'Wealthsimple%' OR short_code ~ '^(HQ|WK|C13)'
ORDER BY short_code;
```

- [ ] **Step 2: Record the mapping and decide per-account shortCode**

For each PDF account-number prefix in the filenames (`HQ4TLFJ02CAD`, `HQ6LMLTK8CAD`, …, `WK*`, and the credit card `C13BRX957CAD`), note whether a row exists and what its `short_code` is. Capture three facts:
  1. Brokerage: does `short_code` equal the full PDF `Account No.` (e.g. `HQ6LMLTK8CAD`), or a variant (no currency suffix, last-4)?
  2. Activities-export rows: query `SELECT DISTINCT a.short_code FROM accounts a JOIN investment_activities ia ON ia.account_id = a.id;` — confirm WS activity rows hang off these same `short_code`s.
  3. Credit card: what `short_code` does the existing WS credit-card account use (the CSV `wsid`)? Is it `C13BRX957CAD` (filename) or something else?

- [ ] **Step 3: Encode the decision**

Write the resolved `filename-prefix → shortCode` rule into a constant the backfill will use (Task 10). If brokerage `Account No.` matches stored `short_code` verbatim → the body-driven feature path also works unchanged. If the credit-card stored `short_code` ≠ `C13BRX957CAD`, the backfill must map the filename prefix to the stored `short_code` explicitly. **Do not proceed to Task 10's commit step until this mapping is confirmed against prod.**

---

## Task 3: Extend PdfParser for dedup declarations + wire parseStatementFile

**Files:**
- Modify: `backend/src/import/pdf/types.ts:99-106`
- Modify: `backend/src/import/parseStatementFile.ts:769-814`
- Test: `backend/test/pdfWealthsimpleBrokerage.test.ts` (the wiring is covered indirectly; add a focused unit test in `backend/test/pdfDedupWiring.test.ts`)

- [ ] **Step 1: Write the failing test for the fingerprint/flag wiring**

Create `backend/test/pdfDedupWiring.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stableFingerprint } from '../src/import/fingerprint';

// Mirrors the ws_holding fingerprint the WS holdings CSV importer writes
// (runImport.ts) — the WS brokerage PDF holdings MUST produce the identical
// hash so they collide on the sourceRowFingerprint unique index.
test('ws_holding fingerprint is stable and field-ordered like the CSV path', () => {
  const fp = stableFingerprint({
    kind: 'ws_holding',
    accountId: 7,
    statementDate: '2025-05-31',
    symbol: 'VFV',
    currency: 'CAD',
  });
  assert.equal(
    fp,
    stableFingerprint({
      kind: 'ws_holding',
      accountId: 7,
      statementDate: '2025-05-31',
      symbol: 'VFV',
      currency: 'CAD',
    }),
  );
  // Different from the generic kind:'holding' scheme.
  assert.notEqual(
    fp,
    stableFingerprint({
      kind: 'holding',
      accountId: 7,
      statementDate: '2025-05-31',
      symbol: 'VFV',
      quantity: 1,
      marketValue: 1,
    }),
  );
});
```

- [ ] **Step 2: Run it to verify it passes** (this asserts the existing `stableFingerprint` contract before we depend on it)

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/pdfDedupWiring.test.ts`
Expected: PASS (2 assertions). This locks the fingerprint shape we target.

- [ ] **Step 3: Add the optional declarations to `PdfParser`**

In `backend/src/import/pdf/types.ts`, extend the `PdfParser` type (currently ends at the `parse` field):

```ts
export type PdfParser = {
  id: string;
  label: string;
  /** Cheap content sniff — return true if this parser can handle the PDF. */
  sniff: (lines: PdfLine[]) => boolean;
  /** Parse all transactions out of the PDF. */
  parse: (lines: PdfLine[], ctx: PdfParseContext) => PdfParseResult;
  /**
   * When set, `parseStatementFile` stamps `preview.crossSourceDedup` with this
   * value so the commit pipeline runs the fuzzy investment-activity matcher
   * against existing DB rows before inserting. Use for parsers whose source
   * overlaps another importer (Wealthsimple PDF vs Wealthsimple CSV).
   */
  crossSourceDedup?: 'fuzzy-window-5d';
  /**
   * Holding fingerprint scheme. Default (omitted) = the generic
   * kind:'holding' scheme. 'ws_holding' makes emitted holdings hash
   * identically to the Wealthsimple holdings CSV importer so the same
   * month-end snapshot does not duplicate across the two sources.
   */
  holdingFingerprint?: 'ws_holding';
};
```

- [ ] **Step 4: Honor the declarations in the `.pdf` branch**

In `backend/src/import/parseStatementFile.ts`, replace the holdings-mapping block (currently `:781-791`) so the fingerprint scheme follows the parser, and add the `crossSourceDedup` flag to the preview object (currently `:792-812`):

```ts
    const holdings: NormalizedHoldingSnapshot[] = (out.holdings ?? []).map((h) => ({
      ...h,
      sourceRowFingerprint:
        parser.holdingFingerprint === 'ws_holding'
          ? stableFingerprint({
              kind: 'ws_holding',
              accountId: account.id,
              statementDate: h.statementDate,
              symbol: h.security.symbol.toUpperCase(),
              currency: h.currency,
            })
          : stableFingerprint({
              kind: 'holding',
              accountId: account.id,
              statementDate: h.statementDate,
              symbol: h.security.symbol,
              quantity: h.quantity,
              marketValue: h.marketValue,
            }),
    }));
    const preview = {
      ...base,
      usedParser: 'pdf' as const,
      usedProfileId: parser.id,
      ...(parser.crossSourceDedup ? { crossSourceDedup: parser.crossSourceDedup } : {}),
      transactions,
      investmentActivities,
      holdings,
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
```

- [ ] **Step 5: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: no new errors. (`crossSourceDedup` already exists on `StatementPreview`; `holdingFingerprint` is new but optional.)

- [ ] **Step 6: Commit**

```bash
git add backend/src/import/pdf/types.ts backend/src/import/parseStatementFile.ts backend/test/pdfDedupWiring.test.ts
git commit --no-verify -m "feat(import): let PDF parsers declare cross-source dedup + ws_holding fingerprint"
```

---

## Task 4: Shared WS activity-code taxonomy

**Files:**
- Create: `backend/src/import/pdf/wealthsimpleActivityCodes.ts`
- Test: `backend/test/pdfWealthsimpleBrokerage.test.ts` (taxonomy assertions added here; the file is created in this task and extended later)

> **Alignment requirement:** the `activityType` strings below MUST match what `wealthsimpleActivitiesExportParse.ts` and `wealthsimpleInvestParse.ts` (`TX_TO_ACTIVITY`) store for the same WS code, or the fuzzy matcher (which keys on `activityType`) will miss cross-source duplicates. Before finalizing, read `backend/src/import/wealthsimpleActivitiesExportParse.ts`'s classifier and reconcile any disagreement — the CSV classification wins.

- [ ] **Step 1: Write the failing test**

Create `backend/test/pdfWealthsimpleBrokerage.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wsPdfCodeToActivity, WS_PDF_SKIP_CODES } from '../src/import/pdf/wealthsimpleActivityCodes';

test('wsPdfCodeToActivity aligns with TX_TO_ACTIVITY for shared codes', () => {
  assert.equal(wsPdfCodeToActivity('BUY'), 'buy');
  assert.equal(wsPdfCodeToActivity('SELL'), 'sell');
  assert.equal(wsPdfCodeToActivity('DIV'), 'dividend');
  assert.equal(wsPdfCodeToActivity('INT'), 'interest');
  assert.equal(wsPdfCodeToActivity('FPLINT'), 'interest');
  assert.equal(wsPdfCodeToActivity('FEE'), 'fee');
  assert.equal(wsPdfCodeToActivity('CONT'), 'transfer');
  assert.equal(wsPdfCodeToActivity('CRYPTORWD'), 'staking_reward');
});

test('wsPdfCodeToActivity maps cash-movement / transfer codes', () => {
  assert.equal(wsPdfCodeToActivity('DEP'), 'cash_movement');
  assert.equal(wsPdfCodeToActivity('WD'), 'cash_movement');
  assert.equal(wsPdfCodeToActivity('TRFIN'), 'transfer_in');
  assert.equal(wsPdfCodeToActivity('TRFOUT'), 'transfer_out');
  assert.equal(wsPdfCodeToActivity('ROC'), 'return_of_capital');
});

test('zero-cash stock-lending codes are flagged skip, not misclassified', () => {
  assert.ok(WS_PDF_SKIP_CODES.has('LOAN'));
  assert.ok(WS_PDF_SKIP_CODES.has('RECALL'));
  assert.equal(wsPdfCodeToActivity('LOAN'), null);
});

test('unknown code returns null', () => {
  assert.equal(wsPdfCodeToActivity('ZZZ'), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/pdfWealthsimpleBrokerage.test.ts`
Expected: FAIL — `Cannot find module '.../wealthsimpleActivityCodes'`.

- [ ] **Step 3: Implement the taxonomy**

Create `backend/src/import/pdf/wealthsimpleActivityCodes.ts`:

```ts
import type { NormalizedInvestmentActivity } from '../statementTypes';

type ActivityType = NormalizedInvestmentActivity['activityType'];

/**
 * Wealthsimple brokerage-statement "Transaction" code → cashflow activityType.
 *
 * Shared codes (BUY/SELL/DIV/INT/FPLINT/CONT/FEE/CRYPTORWD) are kept identical
 * to TX_TO_ACTIVITY in wealthsimpleInvestParse.ts so a PDF-sourced row and a
 * CSV-sourced row for the same event classify the same — required for the
 * fuzzy matcher (keys on activityType) to dedup across sources. The remaining
 * codes come from the statement's own "Information about Statement Codes"
 * legend; reconcile with wealthsimpleActivitiesExportParse.ts before relying
 * on them for dedup.
 */
const MAP: Record<string, ActivityType> = {
  BUY: 'buy',
  SELL: 'sell',
  DIV: 'dividend',
  STKDIV: 'dividend',
  INT: 'interest',
  FPLINT: 'interest',
  FEE: 'fee',
  DCTFEE: 'fee',
  DSCFEE: 'fee',
  CONT: 'transfer',
  DEP: 'cash_movement',
  WD: 'cash_movement',
  WDQ: 'cash_movement',
  TRFIN: 'transfer_in',
  TRFINTF: 'transfer_in',
  WIREIN: 'transfer_in',
  WIREINTF: 'transfer_in',
  TRFOUT: 'transfer_out',
  TRFOUTTF: 'transfer_out',
  ROC: 'return_of_capital',
  CRYPTORWD: 'staking_reward',
};

/**
 * Codes that represent zero-cash, zero-position-change events (stock lending,
 * mark-to-market, journals). We do NOT emit InvestmentActivity rows for them —
 * the invest-CSV path drops them too — but the parser counts them in warnings
 * so nothing is silently lost.
 */
export const WS_PDF_SKIP_CODES = new Set<string>([
  'LOAN', 'RECALL', 'STKDIS', 'STAKE', 'UNSTAKE', 'MTM', 'CORRECTION', 'JRL', 'STKREORG',
]);

export function wsPdfCodeToActivity(code: string | null | undefined): ActivityType | null {
  if (!code) return null;
  return MAP[String(code).trim().toUpperCase()] ?? null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/pdfWealthsimpleBrokerage.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/pdf/wealthsimpleActivityCodes.ts backend/test/pdfWealthsimpleBrokerage.test.ts
git commit --no-verify -m "feat(import): WS brokerage transaction-code taxonomy"
```

---

## Task 5: WS credit-card parser

**Files:**
- Create: `backend/src/import/pdf/wealthsimpleCreditCard.ts`
- Test: `backend/test/pdfWealthsimpleCreditCard.test.ts`

Real statement shape (from the captured `/tmp/ws_cc.txt`):
- `Wealthsimple Apr 15 — May 14, 2026` (period; en-dash `—`)
- `Statement date May 15, 2026`
- `4126 50** **** 3338` (masked card; last-4 = `3338`)
- Activity rows: `Apr 16   Apr 17   Purchase   A&W #4655   $10.49` and `May 6   May 6   Payment   From chequing account   –$4,404.43` (note the `–` minus is U+2013).

- [ ] **Step 1: Write the failing test — sniff + header**

Create `backend/test/pdfWealthsimpleCreditCard.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfLine } from '../src/import/pdf/types';
import { wealthsimpleCreditCardParser, parseWsCreditCardHeader } from '../src/import/pdf/wealthsimpleCreditCard';

function mk(text: string, page = 1, y = 0): PdfLine {
  return { page, y, text };
}

test('sniff requires Wealthsimple + credit-card markers', () => {
  assert.equal(
    wealthsimpleCreditCardParser.sniff([mk('Credit card statement'), mk('Wealthsimple Payments Inc.')]),
    true,
  );
  assert.equal(wealthsimpleCreditCardParser.sniff([mk('Credit card statement')]), false);
  assert.equal(wealthsimpleCreditCardParser.sniff([mk('CIBC Costco Mastercard')]), false);
});

test('header extracts period, statement date, last-4', () => {
  const h = parseWsCreditCardHeader([
    mk('Credit card statement'),
    mk('Wealthsimple Apr 15 — May 14, 2026'),
    mk('4126 50** **** 3338'),
    mk('Statement date May 15, 2026   Minimum payment $10.00'),
  ]);
  assert.equal(h.accountType, 'credit_card');
  assert.equal(h.productLabel, 'Wealthsimple Credit Card');
  assert.equal(h.accountSuffix, '3338');
  assert.equal(h.periodStart, '2026-04-15');
  assert.equal(h.periodEnd, '2026-05-14');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/pdfWealthsimpleCreditCard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement sniff + header**

Create `backend/src/import/pdf/wealthsimpleCreditCard.ts`:

```ts
import type { PdfLine, PdfParser, PdfParseResult, PdfStatementHeader } from './types';
import { normalizeMerchant } from '../normalizeMerchant';

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function toIso(year: number, monthZeroBased: number, day: number): string {
  return `${year}-${String(monthZeroBased + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

type Period = { start: string; end: string };

// "Apr 15 — May 14, 2026"  (em/en dash). Start month/day, end month/day/year.
const PERIOD_RE =
  /([A-Z][a-z]{2})\s+(\d{1,2})\s*[—–-]\s*([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})/;

function parsePeriod(lines: PdfLine[]): Period {
  for (const l of lines) {
    const m = PERIOD_RE.exec(l.text);
    if (!m) continue;
    const startMonth = MONTHS[m[1]];
    const endMonth = MONTHS[m[3]];
    if (startMonth === undefined || endMonth === undefined) continue;
    const endYear = Number(m[5]);
    // Start year = endYear unless the range crosses a Dec→Jan boundary.
    const startYear = startMonth > endMonth ? endYear - 1 : endYear;
    return {
      start: toIso(startYear, startMonth, Number(m[2])),
      end: toIso(endYear, endMonth, Number(m[4])),
    };
  }
  throw new Error('WS credit card: could not parse statement period');
}

function parseLast4(lines: PdfLine[]): string {
  for (const l of lines) {
    const m = /\b\d{4}\s+\d{2}\*{2}\s+\*{4}\s+(\d{4})\b/.exec(l.text);
    if (m) return m[1];
  }
  throw new Error('WS credit card: could not parse card last-4');
}

export function parseWsCreditCardHeader(lines: PdfLine[]): PdfStatementHeader {
  const period = parsePeriod(lines);
  return {
    accountSuffix: parseLast4(lines),
    productLabel: 'Wealthsimple Credit Card',
    accountType: 'credit_card',
    periodStart: period.start,
    periodEnd: period.end,
    currency: 'CAD',
  };
}

export const wealthsimpleCreditCardParser: PdfParser = {
  id: 'wealthsimple_credit_card',
  label: 'Wealthsimple Credit Card',
  sniff: (lines) => {
    let cc = false;
    let ws = false;
    for (const l of lines) {
      if (l.text.includes('Credit card statement')) cc = true;
      if (/Wealthsimple/.test(l.text)) ws = true;
      if (cc && ws) return true;
    }
    return false;
  },
  // parse implemented in the next step
  parse: () => ({ transactions: [], warnings: [], parseErrors: [] }),
};
```

- [ ] **Step 4: Run to verify header tests pass**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/pdfWealthsimpleCreditCard.test.ts`
Expected: PASS (sniff + header).

- [ ] **Step 5: Write the failing test — rows + sign convention + year inference**

Append to `backend/test/pdfWealthsimpleCreditCard.test.ts`:

```ts
test('parse extracts purchases (negative) and payments (positive)', () => {
  const lines: PdfLine[] = [
    mk('Credit card statement'),
    mk('Wealthsimple Apr 15 — May 14, 2026'),
    mk('4126 50** **** 3338'),
    mk('Statement date May 15, 2026'),
    mk('TRANS. DATE   POSTED DATE   TYPE   DETAILS   AMOUNT ($CAD)', 2),
    mk('Apr 16   Apr 17   Purchase   A&W #4655   $10.49', 2),
    mk('May 6   May 6   Payment   From chequing account   –$4,404.43', 2),
    mk("May 13   May 14   Purchase   LONGO'S GUELPH   $1.46", 2),
  ];
  const result = wealthsimpleCreditCardParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 3);

  const aw = result.transactions.find((t) => t.merchantRaw.includes('A&W'))!;
  assert.equal(aw.amount, -10.49);          // purchase → charge → negative
  assert.equal(aw.date, '2026-04-16');       // TRANS. DATE, year inferred
  assert.equal(aw.currency, 'CAD');

  const pay = result.transactions.find((t) => t.merchantRaw.includes('chequing'))!;
  assert.equal(pay.amount, 4404.43);         // payment → credit → positive
  assert.equal(pay.date, '2026-05-06');
});

test('parse infers prior year across the Jan boundary', () => {
  const lines: PdfLine[] = [
    mk('Credit card statement'),
    mk('Wealthsimple Dec 15 — Jan 14, 2026'),
    mk('4126 50** **** 3338'),
    mk('Statement date Jan 15, 2026'),
    mk('TRANS. DATE   POSTED DATE   TYPE   DETAILS   AMOUNT ($CAD)', 2),
    mk('Dec 20   Dec 21   Purchase   IKEA   $50.00', 2),
    mk('Jan 3   Jan 4   Purchase   ZEHRS   $20.00', 2),
  ];
  const result = wealthsimpleCreditCardParser.parse(lines, { defaultCurrency: 'CAD' });
  const ikea = result.transactions.find((t) => t.merchantRaw.includes('IKEA'))!;
  assert.equal(ikea.date, '2025-12-20');
  const zehrs = result.transactions.find((t) => t.merchantRaw.includes('ZEHRS'))!;
  assert.equal(zehrs.date, '2026-01-03');
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/pdfWealthsimpleCreditCard.test.ts`
Expected: FAIL — `parse` returns no transactions.

- [ ] **Step 7: Implement `parse` rows + sign + year inference**

In `backend/src/import/pdf/wealthsimpleCreditCard.ts`, add helpers above the parser and replace the stub `parse`:

```ts
const MONTH_DAY_RE = /^([A-Z][a-z]{2})\s+(\d{1,2})\b/;

function inferYear(monthZeroBased: number, period: Period): number {
  const startYear = Number(period.start.slice(0, 4));
  const endYear = Number(period.end.slice(0, 4));
  if (startYear === endYear) return startYear;
  // Range crosses Dec→Jan: months >= start-month belong to startYear.
  const startMonth = Number(period.start.slice(5, 7)) - 1;
  return monthZeroBased >= startMonth ? startYear : endYear;
}

function rowDate(monthDay: string, period: Period): string {
  const m = MONTH_DAY_RE.exec(monthDay.trim());
  if (!m) throw new Error(`WS credit card: unparseable date cell ${JSON.stringify(monthDay)}`);
  const month = MONTHS[m[1]];
  if (month === undefined) throw new Error(`WS credit card: unknown month ${m[1]}`);
  return toIso(inferYear(month, period), month, Number(m[2]));
}

// Amount like "$10.49" or "–$4,404.43" (U+2013) or "-$4,404.43".
function parseAmount(raw: string): { magnitude: number; isCredit: boolean } {
  const isCredit = /^[–-]/.test(raw.trim());
  const n = Number(raw.replace(/[–\-$,\s]/g, ''));
  return { magnitude: n, isCredit };
}

const TYPE_RE = /\b(Purchase|Payment|Refund|Reversal|Interest|Fee|Cash advance)\b/i;
```

Replace `parse`:

```ts
  parse: (lines, ctx): PdfParseResult => {
    const header = parseWsCreditCardHeader(lines);
    const period: Period = { start: header.periodStart, end: header.periodEnd };
    const transactions: PdfParseResult['transactions'] = [];
    const warnings: string[] = [];
    const parseErrors: PdfParseResult['parseErrors'] = [];

    let idx = 0;
    for (const l of lines) {
      const cols = l.text.trim().split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
      // A data row starts with two "Mon DD" date columns.
      if (cols.length < 4) continue;
      if (!MONTH_DAY_RE.test(cols[0]) || !MONTH_DAY_RE.test(cols[1])) continue;
      if (!TYPE_RE.test(cols[2])) continue;
      idx += 1;
      try {
        const type = cols[2];
        const merchantRaw = cols.slice(3, cols.length - 1).join(' ').replace(/\s+/g, ' ').trim();
        const { magnitude, isCredit } = parseAmount(cols[cols.length - 1]);
        if (!Number.isFinite(magnitude)) {
          throw new Error(`unparseable amount ${JSON.stringify(cols[cols.length - 1])}`);
        }
        const abs = Math.abs(magnitude);
        // Cashflow convention: positive = credit, negative = charge.
        // Payments/refunds (printed with leading "–") are credits → positive.
        // Purchases (printed positive) are charges → negative.
        const amount = isCredit ? abs : -abs;
        transactions.push({
          date: rowDate(cols[0], period),
          merchantRaw,
          merchantClean: normalizeMerchant(merchantRaw),
          amount,
          currency: ctx.defaultCurrency,
          sourceReference: null,
        });
      } catch (err) {
        parseErrors.push({ rowIndex: idx, message: (err as Error).message });
      }
    }

    return {
      transactions,
      header,
      warnings,
      parseErrors,
    };
  },
```

- [ ] **Step 8: Run to verify all credit-card tests pass**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/pdfWealthsimpleCreditCard.test.ts`
Expected: PASS (sniff, header, rows, year inference).

- [ ] **Step 9: Add reconciliation warning test + implement**

Append test:

```ts
test('parse warns when purchases sum disagrees with Account summary Purchases total', () => {
  const lines: PdfLine[] = [
    mk('Credit card statement'),
    mk('Wealthsimple Apr 15 — May 14, 2026'),
    mk('4126 50** **** 3338'),
    mk('Statement date May 15, 2026'),
    mk('+ Purchases $1,474.04'),
    mk('TRANS. DATE   POSTED DATE   TYPE   DETAILS   AMOUNT ($CAD)', 2),
    mk('Apr 16   Apr 17   Purchase   A&W #4655   $10.49', 2),
  ];
  const result = wealthsimpleCreditCardParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.ok(result.warnings.some((w) => /Purchases.*mismatch/i.test(w)));
});
```

In `parse`, before the `return`, add reconciliation:

```ts
    const purchasesTotal = (() => {
      for (const l of lines) {
        const m = /Purchases\s+\$([\d,]+\.\d{2})/.exec(l.text);
        if (m) return Number(m[1].replace(/,/g, ''));
      }
      return null;
    })();
    if (purchasesTotal != null) {
      const parsedPurchases = transactions
        .filter((t) => t.amount < 0)
        .reduce((s, t) => s + Math.abs(t.amount), 0);
      if (Math.abs(parsedPurchases - purchasesTotal) > 0.01) {
        warnings.push(
          `Purchases total mismatch: parsed ${parsedPurchases.toFixed(2)} vs statement ${purchasesTotal.toFixed(2)}`,
        );
      }
    }
```

- [ ] **Step 10: Run; then validate against a real PDF**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/pdfWealthsimpleCreditCard.test.ts`
Expected: PASS.

Then sanity-check on a real file (no DB write):

```bash
tsx -e "import('./src/import/pdf/extractLines').then(async m=>{const fs=require('fs');const {wealthsimpleCreditCardParser}=require('./src/import/pdf/wealthsimpleCreditCard');const lines=await m.extractPdfLines(fs.readFileSync('/Users/connoradams/Downloads/monthly_pdf_statements/C13BRX957CAD_2026-05_CREDIT_CARD.pdf'));const r=wealthsimpleCreditCardParser.parse(lines,{defaultCurrency:'CAD'});console.log(JSON.stringify({n:r.transactions.length,head:r.header,warnings:r.warnings,sample:r.transactions.slice(0,5)},null,2));})"
```
Expected: ~20 transactions, header last-4 `3338`, no reconciliation warning (parsed purchases ≈ statement `$1,474.04`). If a warning fires, fix tokenization to match the captured lines.

- [ ] **Step 11: Commit**

```bash
git add backend/src/import/pdf/wealthsimpleCreditCard.ts backend/test/pdfWealthsimpleCreditCard.test.ts
git commit --no-verify -m "feat(import): Wealthsimple credit-card PDF parser"
```

---

## Task 6: WS brokerage parser — header

**Files:**
- Create: `backend/src/import/pdf/wealthsimpleBrokerage.ts`
- Test: `backend/test/pdfWealthsimpleBrokerage.test.ts`

Real header shape (from `/tmp/ws_brk_cad.txt`):
- `Account No. Owner Statement Period` then `HQ6LMLTK8CAD Connor Adams 2025-05-01 - 2025-05-31`
- account-type label line, e.g. `Tax-Free Savings SDI Cash Account` or `Self-directed Non-Registered Margin Account`.

- [ ] **Step 1: Write failing tests for sniff + header**

Append to `backend/test/pdfWealthsimpleBrokerage.test.ts`:

```ts
import type { PdfLine } from '../src/import/pdf/types';
import { wealthsimpleBrokerageParser, parseWsBrokerageHeader } from '../src/import/pdf/wealthsimpleBrokerage';

function mk(text: string, page = 1, y = 0): PdfLine {
  return { page, y, text };
}

test('brokerage sniff requires order-execution + Wealthsimple, not Questrade', () => {
  assert.equal(
    wealthsimpleBrokerageParser.sniff([
      mk('ORDER EXECUTION ONLY ACCOUNT'),
      mk('Wealthsimple Investments Inc.'),
      mk('Account No. Owner Statement Period'),
    ]),
    true,
  );
  // Questrade also says "order execution only account" — must NOT match it.
  assert.equal(
    wealthsimpleBrokerageParser.sniff([mk('QUESTRADE'), mk('Order execution only account')]),
    false,
  );
});

test('brokerage header parses account no., period, TFSA label', () => {
  const h = parseWsBrokerageHeader([
    mk('ORDER EXECUTION ONLY ACCOUNT'),
    mk('Account No. Owner Statement Period'),
    mk('HQ6LMLTK8CAD Connor Adams 2025-05-01 - 2025-05-31'),
    mk('Tax-Free Savings SDI Cash Account'),
  ]);
  assert.equal(h.accountSuffix, 'HQ6LMLTK8CAD');
  assert.equal(h.accountType, 'investment');
  assert.equal(h.productLabel, 'Wealthsimple TFSA');
  assert.equal(h.periodStart, '2025-05-01');
  assert.equal(h.periodEnd, '2025-05-31');
  assert.equal(h.accountHolder, 'Connor Adams');
});

test('brokerage header detects margin label', () => {
  const h = parseWsBrokerageHeader([
    mk('ORDER EXECUTION ONLY ACCOUNT'),
    mk('Account No. Owner Statement Period'),
    mk('HQ4TLFJ02CAD Connor Adams 2026-04-01 - 2026-04-30'),
    mk('Self-directed Non-Registered Margin Account'),
  ]);
  assert.equal(h.productLabel, 'Wealthsimple Investing');
  assert.equal(h.accountSuffix, 'HQ4TLFJ02CAD');
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/pdfWealthsimpleBrokerage.test.ts`
Expected: FAIL — `wealthsimpleBrokerage` module not found.

- [ ] **Step 3: Implement sniff + header**

Create `backend/src/import/pdf/wealthsimpleBrokerage.ts`:

```ts
import type { PdfLine, PdfParser, PdfParseResult, PdfStatementHeader } from './types';
import type { NormalizedHoldingSnapshot, NormalizedInvestmentActivity } from '../statementTypes';
import { normalizeMerchant } from '../normalizeMerchant';
import { wsPdfCodeToActivity, WS_PDF_SKIP_CODES } from './wealthsimpleActivityCodes';

const ACCOUNT_LINE_RE = /\b([A-Z]{2}[A-Z0-9]{6,12}(?:CAD|USD))\b\s+(.+?)\s+(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/;

function detectProductLabel(lines: PdfLine[]): string {
  const all = lines.map((l) => l.text).join(' ');
  if (/Tax-Free Savings|\bTFSA\b/i.test(all)) return 'Wealthsimple TFSA';
  if (/First Home Savings|\bFHSA\b/i.test(all)) return 'Wealthsimple FHSA';
  if (/Retirement Savings|\bRRSP\b/i.test(all)) return 'Wealthsimple RRSP';
  if (/Registered Education|\bRESP\b/i.test(all)) return 'Wealthsimple RESP';
  if (/Cash Account|Save\b/i.test(all) && !/Margin/i.test(all)) return 'Wealthsimple Cash';
  if (/Margin|Non-Registered/i.test(all)) return 'Wealthsimple Investing';
  return 'Wealthsimple Investing';
}

export function parseWsBrokerageHeader(lines: PdfLine[]): PdfStatementHeader {
  let accountSuffix: string | null = null;
  let holder: string | null = null;
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  for (const l of lines) {
    const m = ACCOUNT_LINE_RE.exec(l.text);
    if (m) {
      accountSuffix = m[1];
      holder = m[2].trim();
      periodStart = m[3];
      periodEnd = m[4];
      break;
    }
  }
  if (!accountSuffix || !periodStart || !periodEnd) {
    throw new Error('WS brokerage header: could not parse Account No. / Statement Period line');
  }
  const currency = accountSuffix.endsWith('USD') ? 'USD' : 'CAD';
  return {
    accountSuffix,
    productLabel: detectProductLabel(lines),
    accountType: 'investment',
    periodStart,
    periodEnd,
    currency,
    accountHolder: holder ?? undefined,
  };
}

export const wealthsimpleBrokerageParser: PdfParser = {
  id: 'wealthsimple_brokerage',
  label: 'Wealthsimple Brokerage Statement',
  crossSourceDedup: 'fuzzy-window-5d',
  holdingFingerprint: 'ws_holding',
  sniff: (lines) => {
    let orderExec = false;
    let ws = false;
    let questrade = false;
    for (const l of lines) {
      if (/ORDER EXECUTION ONLY ACCOUNT/i.test(l.text)) orderExec = true;
      if (/Wealthsimple/i.test(l.text)) ws = true;
      if (/Questrade/i.test(l.text)) questrade = true;
    }
    return orderExec && ws && !questrade;
  },
  // parse implemented in Tasks 7-8
  parse: (lines) => ({
    transactions: [],
    investmentActivities: [],
    holdings: [],
    header: parseWsBrokerageHeader(lines),
    warnings: [],
    parseErrors: [],
  }),
};
```

> **Adjust `ACCOUNT_LINE_RE` to the captured text.** If pdfjs splits "Account No." and the value across y-buckets (as it does for some layouts), match the value line on its own (`^([A-Z]{2}[A-Z0-9]{6,12}(?:CAD|USD))\s+(.+?)\s+(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})$`) and scan all lines; the test fixtures above assume the value is on one line.

- [ ] **Step 4: Run to verify header tests pass**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/pdfWealthsimpleBrokerage.test.ts`
Expected: PASS (taxonomy + sniff + header).

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/pdf/wealthsimpleBrokerage.ts backend/test/pdfWealthsimpleBrokerage.test.ts
git commit --no-verify -m "feat(import): WS brokerage parser — sniff + header"
```

---

## Task 7: WS brokerage parser — holdings

**Files:**
- Modify: `backend/src/import/pdf/wealthsimpleBrokerage.ts`
- Test: `backend/test/pdfWealthsimpleBrokerage.test.ts`

Real holdings shape (`Portfolio Equities` table, from `/tmp/ws_brk_cad.txt`):
`<Name...> <TICKER> <TotalQty> <SegregatedQty> <QtyOnLoan> <MktPrice> [CAD] <MktValue> <BookCost>`
e.g. `Vanguard S&P 500 Index ETF VFV 21.9905 21.9905 0.0000 $143.95 $3,165.53 $3,042.25`
Grouped under `Canadian Equities and Alternatives` / `US Equities and Alternatives`. A `Total` line closes each group.

- [ ] **Step 1: Write the failing test**

Append:

```ts
test('brokerage parses Portfolio Equities holdings with currency grouping', () => {
  const lines: PdfLine[] = [
    mk('ORDER EXECUTION ONLY ACCOUNT'),
    mk('Account No. Owner Statement Period'),
    mk('HQ6LMLTK8CAD Connor Adams 2025-05-01 - 2025-05-31'),
    mk('Tax-Free Savings SDI Cash Account'),
    mk('Portfolio Equities', 2),
    mk('Symbol Total Quantity Segregated Quantity on Market Market Book', 2),
    mk('Canadian Equities and Alternatives', 2),
    mk('Vanguard S&P 500 Index ETF VFV 21.9905 21.9905 0.0000 $143.95 $3,165.53 $3,042.25', 2),
    mk('The Toronto-Dominion Bank TD 2.0766 2.0766 0.0000 $94.77 CAD $196.79 $163.43', 2),
    mk('Total $4,028.96 $4,108.04', 2),
    mk('Activity - Current period', 2),
  ];
  const result = wealthsimpleBrokerageParser.parse(lines, { defaultCurrency: 'CAD' });
  const vfv = result.holdings!.find((h) => h.security.symbol === 'VFV')!;
  assert.equal(vfv.security.name, 'Vanguard S&P 500 Index ETF');
  assert.equal(vfv.quantity, 21.9905);
  assert.equal(vfv.price, 143.95);
  assert.equal(vfv.marketValue, 3165.53);
  assert.equal(vfv.costBasis, 3042.25);
  assert.equal(vfv.currency, 'CAD');
  assert.equal(vfv.statementDate, '2025-05-31');
  // The "Total" row must not be parsed as a holding.
  assert.equal(result.holdings!.length, 2);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/pdfWealthsimpleBrokerage.test.ts`
Expected: FAIL — holdings empty (parse is still the stub).

- [ ] **Step 3: Implement holdings parsing**

In `backend/src/import/pdf/wealthsimpleBrokerage.ts`, add above the parser:

```ts
type Holding = Omit<NormalizedHoldingSnapshot, 'sourceRowFingerprint'>;

const MONEY = String.raw`\$?-?[\d,]+\.\d{2,8}`;
const TICKER = String.raw`[A-Z][A-Z0-9.]{0,9}`;
// <Name...> <TICKER> <totalQty> <segQty> <loanQty> <price> [CAD|USD] <mktValue> <bookCost>
const HOLDING_RE = new RegExp(
  String.raw`^(.+?)\s+(` + TICKER + String.raw`)\s+([\d,]+\.\d{1,8})\s+([\d,]+\.\d{1,8})\s+([\d,]+\.\d{1,8})\s+(` +
    MONEY + String.raw`)\s*(?:CAD|USD)?\s+(` + MONEY + String.raw`)\s+(` + MONEY + String.raw`)\s*$`,
);

function num(s: string): number {
  return Number(s.replace(/[$,]/g, ''));
}

function parseHoldings(lines: PdfLine[], statementDate: string): Holding[] {
  const out: Holding[] = [];
  const SECTION_RE = /^(Canadian|US|United States|International)\s+Equities|^Fixed Income|^Cash Equivalents/i;
  const STOP_RE = /^Activity\b|Current period|Stock Lending|STATEMENT NOTES/i;
  let currency = 'CAD';
  let inHoldings = false;
  for (const l of lines) {
    const t = l.text.trim();
    if (/^Portfolio Equities/i.test(t)) { inHoldings = true; continue; }
    if (!inHoldings) continue;
    if (STOP_RE.test(t)) break;
    const sec = SECTION_RE.exec(t);
    if (sec) { currency = /^US|United States/i.test(t) ? 'USD' : 'CAD'; continue; }
    if (/^Total\b/i.test(t)) continue;
    if (/^Symbol\b/i.test(t)) continue;
    const m = HOLDING_RE.exec(t);
    if (!m) continue;
    out.push({
      statementDate,
      security: { symbol: m[2], name: m[1].trim(), assetType: null, currency },
      quantity: num(m[3]),
      price: num(m[6]),
      marketValue: num(m[7]),
      costBasis: num(m[8]),
      unrealizedGainLoss: null,
      currency,
      sourceReference: null,
    });
  }
  return out;
}
```

Update the parser's `parse` to call it (keep activities empty for now):

```ts
  parse: (lines): PdfParseResult => {
    const header = parseWsBrokerageHeader(lines);
    const holdings = parseHoldings(lines, header.periodEnd);
    return {
      transactions: [],
      investmentActivities: [],
      holdings,
      header,
      warnings: [],
      parseErrors: [],
    };
  },
```

> **Currency-section detection:** the US section header on real statements reads `US Equities and Alternatives (...)`. Confirm against `/tmp/ws_brk_margin.txt` and widen `SECTION_RE` if the captured text differs. The default currency before any section header is the account currency (`header.currency`).

- [ ] **Step 4: Run to verify holdings tests pass**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/pdfWealthsimpleBrokerage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/pdf/wealthsimpleBrokerage.ts backend/test/pdfWealthsimpleBrokerage.test.ts
git commit --no-verify -m "feat(import): WS brokerage parser — holdings snapshot"
```

---

## Task 8: WS brokerage parser — activities

**Files:**
- Modify: `backend/src/import/pdf/wealthsimpleBrokerage.ts`
- Test: `backend/test/pdfWealthsimpleBrokerage.test.ts`

Real activity shape (`Activity - Current period`, columns `Date | Transaction | Description | Debit | Credit | Balance`):
- `2025-05-02   BUY   TD - The Toronto-Dominion Bank: Bought 0.0243 shares (executed at 2025-05-01)   $2.14   $0.00   $50.84`
- Description wraps: the `(executed at YYYY-MM-DD)` tail may land on the next y-bucket. Stitch like `questrade.ts` `collectNeighborDesc`.
- `amount = credit − debit` (BUY → negative cash; DIV/SELL → positive). `tradeDate` = the `executed at` date (matches `wealthsimpleInvestParse`), else the row date. `quantity` from `Bought|Sold N shares`, else null.

- [ ] **Step 1: Write the failing test**

Append:

```ts
test('brokerage parses BUY activity with executed-at date, qty, signed amount', () => {
  const lines: PdfLine[] = [
    mk('ORDER EXECUTION ONLY ACCOUNT'),
    mk('Account No. Owner Statement Period'),
    mk('HQ6LMLTK8CAD Connor Adams 2025-05-01 - 2025-05-31'),
    mk('Tax-Free Savings SDI Cash Account'),
    mk('Activity - Current period', 2, 100),
    mk('Date Transaction Description Debit ($) Credit ($) Balance ($)', 2, 95),
    mk('2025-05-02 BUY TD - The Toronto-Dominion Bank: Bought 0.0243 shares (executed at $2.14 $0.00 $50.84', 2, 90),
    mk('2025-05-01)', 2, 86),
    mk('2025-05-14 FPLINT Stock lending monthly interest payment $0.00 $0.01 $50.85', 2, 70),
  ];
  const result = wealthsimpleBrokerageParser.parse(lines, { defaultCurrency: 'CAD' });
  const acts = result.investmentActivities!;
  const buy = acts.find((a) => a.activityType === 'buy')!;
  assert.equal(buy.security?.symbol, 'TD');
  assert.equal(buy.quantity, 0.0243);
  assert.equal(buy.amount, -2.14);        // credit 0 - debit 2.14
  assert.equal(buy.tradeDate, '2025-05-01'); // executed-at, not the 05-02 row date
  assert.equal(buy.currency, 'CAD');
  const int = acts.find((a) => a.activityType === 'interest')!;
  assert.equal(int.amount, 0.01);          // credit 0.01 - debit 0
  assert.equal(int.quantity, null);
});

test('brokerage drops zero-cash LOAN/RECALL rows but counts them in warnings', () => {
  const lines: PdfLine[] = [
    mk('ORDER EXECUTION ONLY ACCOUNT'),
    mk('Account No. Owner Statement Period'),
    mk('HQ6LMLTK8CAD Connor Adams 2025-05-01 - 2025-05-31'),
    mk('Tax-Free Savings SDI Cash Account'),
    mk('Activity - Current period', 2, 100),
    mk('Date Transaction Description Debit ($) Credit ($) Balance ($)', 2, 95),
    mk('2025-05-02 LOAN PLUR - Plurilock Security Inc.: 7.0000 Shares on loan $0.00 $0.00 $50.84', 2, 90),
  ];
  const result = wealthsimpleBrokerageParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.investmentActivities!.length, 0);
  assert.ok(result.warnings.some((w) => /LOAN|skipped/i.test(w)));
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/pdfWealthsimpleBrokerage.test.ts`
Expected: FAIL — activities empty.

- [ ] **Step 3: Implement activity parsing**

In `backend/src/import/pdf/wealthsimpleBrokerage.ts`, add:

```ts
type Activity = Omit<NormalizedInvestmentActivity, 'sourceRowFingerprint'>;

const ACT_ROW_RE = new RegExp(
  String.raw`^(\d{4}-\d{2}-\d{2})\s+([A-Z]+)\s+(.*?)\s+(` + MONEY + String.raw`)\s+(` + MONEY +
    String.raw`)\s+(` + MONEY + String.raw`)\s*$`,
);
const EXECUTED_AT_RE = /executed at (\d{4}-\d{2}-\d{2})/i;
const QTY_RE = /\b(?:Bought|Sold)\s+([\d.]+)\s+shares?/i;
const TICKER_DESC_RE = /^([A-Z0-9.]+)\s*-\s*(.+?):/;
const ACT_START_RE = /Activity\s*-\s*Current period|^Activity\b/i;
const ACT_STOP_RE = /LEVERAGE DISCLOSURE|STATEMENT NOTES|Information about Statement Codes/i;
const NEIGHBOR_Y = 8;

function parseActivities(
  lines: PdfLine[],
  accountCurrency: string,
): { activities: Activity[]; warnings: string[] } {
  const activities: Activity[] = [];
  const warnings: string[] = [];
  const skipped: Record<string, number> = {};

  // Collect the activity section lines (there may be a CAD section then a USD
  // section for margin accounts; track which currency we're in).
  const section: { line: PdfLine; currency: string }[] = [];
  let inAct = false;
  let currency = accountCurrency;
  for (const l of lines) {
    const t = l.text.trim();
    if (ACT_START_RE.test(t)) {
      inAct = true;
      if (/USD Activity/i.test(t)) currency = 'USD';
      else if (/CAD Activity/i.test(t)) currency = 'CAD';
      continue;
    }
    if (!inAct) continue;
    if (ACT_STOP_RE.test(t)) { inAct = false; continue; }
    if (/USD Activity/i.test(t)) { currency = 'USD'; continue; }
    if (/CAD Activity/i.test(t)) { currency = 'CAD'; continue; }
    section.push({ line: l, currency });
  }

  for (let i = 0; i < section.length; i++) {
    const { line: row, currency: rowCcy } = section[i];
    const m = ACT_ROW_RE.exec(row.text.trim());
    if (!m) continue;
    const [, rowDate, code, descHead, debitS, creditS, _balanceS] = m;
    void _balanceS;

    // Stitch wrapped description continuation lines (no date prefix, near y).
    let desc = descHead.trim();
    for (const { line: n } of section) {
      if (n === row || n.page !== row.page) continue;
      if (Math.abs(n.y - row.y) > NEIGHBOR_Y) continue;
      if (ACT_ROW_RE.test(n.text.trim())) continue;
      if (/^\d{4}-\d{2}-\d{2}/.test(n.text.trim())) continue;
      desc = `${desc} ${n.text.trim()}`.replace(/\s+/g, ' ').trim();
    }

    const activityType = wsPdfCodeToActivity(code);
    if (!activityType) {
      skipped[code] = (skipped[code] ?? 0) + 1;
      continue;
    }

    const debit = num(debitS);
    const credit = num(creditS);
    const amount = Number((credit - debit).toFixed(4));

    const execMatch = EXECUTED_AT_RE.exec(desc);
    const tradeDate = execMatch ? execMatch[1] : rowDate;

    const isTrade = activityType === 'buy' || activityType === 'sell';
    const qtyMatch = isTrade ? QTY_RE.exec(desc) : null;
    const quantity = qtyMatch ? Number(qtyMatch[1]) : null;

    const tk = TICKER_DESC_RE.exec(desc);
    const security = tk
      ? { symbol: tk[1].toUpperCase(), name: tk[2].trim(), assetType: null, currency: rowCcy }
      : null;

    activities.push({
      activityType,
      tradeDate,
      settlementDate: null,
      description: desc,
      security,
      quantity,
      price: null,
      amount,
      fees: null,
      currency: rowCcy,
      sourceReference: null,
    });
  }

  const skippedSummary = Object.entries(skipped)
    .map(([c, n]) => `${c}×${n}`)
    .join(', ');
  if (skippedSummary) {
    warnings.push(`Skipped non-cash activity codes: ${skippedSummary}`);
  }
  return { activities, warnings };
}
```

Update `parse` to wire activities + warnings:

```ts
  parse: (lines): PdfParseResult => {
    const header = parseWsBrokerageHeader(lines);
    const holdings = parseHoldings(lines, header.periodEnd);
    const { activities, warnings } = parseActivities(lines, header.currency ?? 'CAD');
    return {
      transactions: [],
      investmentActivities: activities,
      holdings,
      header,
      warnings,
      parseErrors: [],
    };
  },
```

> **`ACT_ROW_RE` is the highest-risk regex.** Validate against `/tmp/ws_brk_cad.txt` and `/tmp/ws_brk_margin.txt`. If pdfjs places the three money columns on the row bucket and only the description tail wraps (the common case), this works. If the money columns themselves wrap, capture trailing money tokens by walking neighbor buckets (mirror `questrade.ts` `parseActivityRow` + `collectNeighborDesc`). Adjust the regex/stitching, not the assertions.

- [ ] **Step 4: Run to verify activity tests pass**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/pdfWealthsimpleBrokerage.test.ts`
Expected: PASS.

- [ ] **Step 5: Validate against real brokerage PDFs (no DB write)**

```bash
tsx -e "import('./src/import/pdf/extractLines').then(async m=>{const fs=require('fs');const {wealthsimpleBrokerageParser}=require('./src/import/pdf/wealthsimpleBrokerage');const lines=await m.extractPdfLines(fs.readFileSync('/Users/connoradams/Downloads/monthly_pdf_statements/HQ6LMLTK8CAD_2025-05_BROKERAGE.pdf'));const r=wealthsimpleBrokerageParser.parse(lines,{defaultCurrency:'CAD'});console.log(JSON.stringify({holdings:r.holdings,acts:r.investmentActivities,warnings:r.warnings,header:r.header},null,2));})"
```
Expected: holdings match the Portfolio Equities table; activities match the Activity table; tickers/quantities/amounts correct. Iterate the regexes against any mismatch before continuing.

- [ ] **Step 6: Commit**

```bash
git add backend/src/import/pdf/wealthsimpleBrokerage.ts backend/test/pdfWealthsimpleBrokerage.test.ts
git commit --no-verify -m "feat(import): WS brokerage parser — activity transactions"
```

---

## Task 9: Register parsers + account templates

**Files:**
- Modify: `backend/src/import/pdf/registry.ts:31-53`
- Modify: `backend/src/import/runImport.ts:855-877` (`PDF_ACCOUNT_TEMPLATES`)
- Test: `backend/test/pdfRegistry.test.ts`

- [ ] **Step 1: Write failing registry test**

Append to `backend/test/pdfRegistry.test.ts` (match the file's existing import/test style):

```ts
test('built-in registry includes the Wealthsimple PDF parsers', async () => {
  const mod = await import('../src/import/pdf/registry');
  mod.clearPdfParsersForTest();
  mod.registerBuiltInPdfParsers();
  const cc = mod.findPdfParser([
    { page: 1, y: 0, text: 'Credit card statement' },
    { page: 1, y: 1, text: 'Wealthsimple Payments Inc.' },
  ]);
  assert.equal(cc?.id, 'wealthsimple_credit_card');
  const brk = mod.findPdfParser([
    { page: 1, y: 0, text: 'ORDER EXECUTION ONLY ACCOUNT' },
    { page: 1, y: 1, text: 'Wealthsimple Investments Inc.' },
  ]);
  assert.equal(brk?.id, 'wealthsimple_brokerage');
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/pdfRegistry.test.ts`
Expected: FAIL — `findPdfParser` returns null / wrong id.

- [ ] **Step 3: Register the parsers**

In `backend/src/import/pdf/registry.ts`, add the requires and registrations inside `registerBuiltInPdfParsers` (register WS brokerage BEFORE questrade so the `!questrade` sniff guard is moot, and credit card anywhere):

```ts
  const { wealthsimpleCreditCardParser } = require('./wealthsimpleCreditCard');
  const { wealthsimpleBrokerageParser } = require('./wealthsimpleBrokerage');
```

and after the existing `registerPdfParser(...)` calls:

```ts
  registerPdfParser(wealthsimpleCreditCardParser);
  registerPdfParser(wealthsimpleBrokerageParser);
```

- [ ] **Step 4: Add WS product labels to `PDF_ACCOUNT_TEMPLATES`**

In `backend/src/import/runImport.ts`, add to the `PDF_ACCOUNT_TEMPLATES` map (these keys must equal `detectProductLabel`'s outputs):

```ts
  'Wealthsimple TFSA': { name: 'Wealthsimple TFSA', accountType: 'investment' },
  'Wealthsimple FHSA': { name: 'Wealthsimple FHSA', accountType: 'investment' },
  'Wealthsimple RRSP': { name: 'Wealthsimple RRSP', accountType: 'investment' },
  'Wealthsimple RESP': { name: 'Wealthsimple RESP', accountType: 'investment' },
  'Wealthsimple Cash': { name: 'Wealthsimple Cash', accountType: 'investment' },
  'Wealthsimple Investing': { name: 'Wealthsimple Investing', accountType: 'investment' },
  'Wealthsimple Credit Card': { name: 'Wealthsimple Credit Card', accountType: 'credit_card' },
```

- [ ] **Step 5: Run registry test + full typecheck**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/pdfRegistry.test.ts && npx tsc --noEmit`
Expected: PASS + no type errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/import/pdf/registry.ts backend/src/import/runImport.ts backend/test/pdfRegistry.test.ts
git commit --no-verify -m "feat(import): register WS PDF parsers + account templates"
```

---

## Task 10: Backfill script (filename-driven, dry-run + commit)

**Files:**
- Create: `backend/scripts/importWealthsimplePdfs.ts`

Resolves each account from the `<acctno>_<YYYY-MM>_<TYPE>.pdf` filename (matching the CSV-stored `shortCode` per Task 2), then reuses `parseStatementFile` + `commitStatementImport`. Two modes: `--dry-run` (parse + report, no writes) and commit (default off; requires `--commit`).

- [ ] **Step 1: Write the script**

Create `backend/scripts/importWealthsimplePdfs.ts`:

```ts
/**
 * Backfill Wealthsimple PDF statements into cashflow.
 *
 * Account identity comes from the filename prefix (<acctno>CAD/USD), which the
 * Task-2 verification confirmed equals the shortCode the WS CSV importers used.
 * Each file is parsed + committed through the same pipeline as a UI upload, so
 * dedup (fuzzy activities + ws_holding fingerprint) applies.
 *
 * Usage:
 *   tsx scripts/importWealthsimplePdfs.ts --dir <path> --household <id> --user <id> [--commit] [--limit N]
 * Default is DRY RUN (no DB writes). Pass --commit to persist.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseStatementFile } from '../src/import/parseStatementFile';
import { commitStatementImport } from '../src/import/commitStatementImport';
import { Account } from '../src/models';

// Filename → account shortCode + currency. ADJUST per Task 2 findings if the
// credit-card stored shortCode differs from the filename prefix.
const FILENAME_RE = /^([A-Z0-9]+(?:CAD|USD))_(\d{4})-(\d{2})_(BROKERAGE|CREDIT_CARD)\.pdf$/i;

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return dflt;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const dir = arg('dir', '/Users/connoradams/Downloads/monthly_pdf_statements')!;
  const householdId = Number(arg('household'));
  const userId = Number(arg('user'));
  const commit = flag('commit');
  const limit = arg('limit') ? Number(arg('limit')) : Infinity;
  if (!householdId || !userId) throw new Error('--household and --user are required (see Task 2)');

  const files = fs.readdirSync(dir).filter((f) => FILENAME_RE.test(f)).sort();
  const report: Array<Record<string, unknown>> = [];
  let processed = 0;

  for (const file of files) {
    if (processed >= limit) break;
    processed += 1;
    const m = FILENAME_RE.exec(file)!;
    const shortCode = m[1].toUpperCase();
    const currency = shortCode.endsWith('USD') ? 'USD' : 'CAD';

    const account = await Account.findOne({ where: { householdId, shortCode } });
    if (!account) {
      report.push({ file, shortCode, status: 'NO_ACCOUNT (create first / verify Task 2 mapping)' });
      continue;
    }

    const buffer = fs.readFileSync(path.join(dir, file));
    const preview = await parseStatementFile({
      buffer,
      fileName: file,
      accountId: account.id,
      householdId,
    });
    if ('error' in preview) {
      report.push({ file, shortCode, status: `PARSE_ERROR: ${preview.error}` });
      continue;
    }

    const base = {
      file,
      shortCode,
      currency,
      parser: preview.usedProfileId,
      txns: preview.transactions.length,
      activities: preview.investmentActivities.length,
      holdings: preview.holdings.length,
      dupCounts: preview.duplicateCounts,
      warnings: preview.warnings,
      parseErrors: preview.parseErrors.length,
    };

    if (!commit) {
      report.push({ ...base, status: 'DRY_RUN' });
      continue;
    }

    const result = await commitStatementImport(preview, userId, householdId);
    report.push({
      ...base,
      status: 'COMMITTED',
      inserted: result.insertedTransactions + result.insertedInvestmentActivities + result.insertedHoldings,
      insertedTxns: result.insertedTransactions,
      insertedActivities: result.insertedInvestmentActivities,
      insertedHoldings: result.insertedHoldings,
      skippedDuplicates: result.skippedDuplicates,
    });
    process.stdout.write(`✓ ${file}: +${base.txns}t/${base.activities}a/${base.holdings}h skipDup=${result.skippedDuplicates}\n`);
  }

  // Summary
  const totals = report.reduce(
    (acc, r) => {
      acc.txns += Number(r.txns ?? 0);
      acc.activities += Number(r.activities ?? 0);
      acc.holdings += Number(r.holdings ?? 0);
      if (typeof r.status === 'string' && r.status.startsWith('PARSE_ERROR')) acc.errors += 1;
      if (r.status === 'NO_ACCOUNT (create first / verify Task 2 mapping)') acc.noAccount += 1;
      return acc;
    },
    { txns: 0, activities: 0, holdings: 0, errors: 0, noAccount: 0 },
  );
  const outPath = `/tmp/ws_pdf_backfill_${commit ? 'commit' : 'dryrun'}.json`;
  fs.writeFileSync(outPath, JSON.stringify({ totals, files: report }, null, 2));
  process.stdout.write(`\nFiles: ${report.length}  txns:${totals.txns} activities:${totals.activities} holdings:${totals.holdings} parseErrors:${totals.errors} noAccount:${totals.noAccount}\n`);
  process.stdout.write(`Report: ${outPath}\n`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

> Confirm `commitStatementImport`'s return field names (`insertedTransactions`, `insertedInvestmentActivities`, `insertedHoldings`, `skippedDuplicates`) against the function signature — they match the bundle importers in `runImport.ts`. Confirm `parseStatementFile`'s option names (`buffer`, `fileName`, `accountId`, `householdId`).

- [ ] **Step 2: Typecheck the script**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/scripts/importWealthsimplePdfs.ts
git commit --no-verify -m "feat(import): Wealthsimple PDF backfill script (dry-run default)"
```

---

## Task 11: Dry-run against prod + report to Connor (GATE)

No code. Produces the diff Connor approves before any write.

- [ ] **Step 1: Resolve household + user ids** (from Task 2's prod query — `SELECT id FROM households;` / `SELECT id FROM users;`).

- [ ] **Step 2: Run the dry-run against prod** (read-only — no `--commit`)

```bash
cd backend
DATABASE_URL="<prod url>" tsx scripts/importWealthsimplePdfs.ts \
  --dir /Users/connoradams/Downloads/monthly_pdf_statements \
  --household <id> --user <id>
```
Expected: `/tmp/ws_pdf_backfill_dryrun.json` written; summary prints. Every file resolves an account (zero `NO_ACCOUNT`), `parseErrors` is 0, and `warnings` are only expected ones (skipped LOAN/RECALL codes, benign reconciliation). 

- [ ] **Step 3: Spot-check overlap dedup** — pick one account-month present in both a prior CSV import and a PDF. In the dry-run, confirm its activities/holdings show up under `dupCounts` (preview-level) or will be caught at commit. If a known-overlapping row shows 0 duplicates, the amount/quantity/activityType normalization is off — fix the parser (Task 8) and re-run. **This is the spec's correctness gate.**

- [ ] **Step 4: Present the report to Connor.** Summarize: files processed, accounts resolved, total new txns/activities/holdings, projected duplicates skipped, any parse errors or unexpected warnings. **Wait for explicit go-ahead before Task 12.**

---

## Task 12: Prod backfill (GATED — only on Connor's go-ahead)

- [ ] **Step 1: Run with `--commit` against prod**

```bash
cd backend
DATABASE_URL="<prod url>" tsx scripts/importWealthsimplePdfs.ts \
  --dir /Users/connoradams/Downloads/monthly_pdf_statements \
  --household <id> --user <id> --commit
```
Expected: per-file `✓` lines; `/tmp/ws_pdf_backfill_commit.json` with insert counts + `skippedDuplicates`.

- [ ] **Step 2: Verify in prod**

```sql
SELECT a.short_code, COUNT(DISTINCT hs.statement_date) AS snapshot_months, COUNT(*) AS holding_rows
FROM holding_snapshots hs JOIN accounts a ON a.id = hs.account_id
WHERE a.name ILIKE 'Wealthsimple%' GROUP BY a.short_code ORDER BY a.short_code;

SELECT a.short_code, COUNT(*) AS activities
FROM investment_activities ia JOIN accounts a ON a.id = ia.account_id
WHERE a.name ILIKE 'Wealthsimple%' GROUP BY a.short_code ORDER BY a.short_code;
```
Expected: monthly holdings snapshots spanning 2023→2026 for the brokerage accounts; activity counts increased; no duplicate explosion (re-running the script a second time inserts ~0 — idempotency check).

- [ ] **Step 3: Idempotency check** — re-run Step 1's command. Expected: `skippedDuplicates` ≈ all rows, `inserted` ≈ 0. Confirms dedup holds.

- [ ] **Step 4: Final PR**

```bash
git push -u origin claude/stoic-pasteur-f814e0
gh pr create --title "feat(import): Wealthsimple PDF statement import + backfill" --body "<summary, link spec + plan>"
gh pr merge --auto --merge
```
(Per Connor's rule: auto-merge with a merge commit, no squash, no co-author trailer.)

---

## Self-Review notes

- **Spec coverage:** credit-card parser (T5), brokerage holdings (T7) + activities (T8), header/account identity (T2, T6), activities fuzzy dedup wiring (T3 `crossSourceDedup` + T8 executed-at/qty/amount alignment), holdings ws_holding fingerprint reuse (T3 + T6 `holdingFingerprint`), reconciliation assertions (T5 credit card; brokerage reconciliation is OPTIONAL — see gap below), backfill dry-run→prod (T10–T12). Registry + templates (T9).
- **Gap accepted:** brokerage-side reconciliation (holdings-total vs Total Portfolio, activity-sum vs cash summary) from the spec is not yet a task. Add as an optional enhancement after T8 if Task 11's dry-run shows parse drift; the credit-card reconciliation pattern (T5 Step 9) is the template. Flagged rather than silently dropped.
- **Type consistency:** `wsPdfCodeToActivity` / `WS_PDF_SKIP_CODES` (T4) used in T8; `parseWsBrokerageHeader` / `parseWsCreditCardHeader` exported and used in tests + parse; `holdingFingerprint`/`crossSourceDedup` added in T3 and set in T6's parser object. `num`/`MONEY` defined in T7, reused in T8 (same file).
- **Placeholders:** none — every code step has real code; fixture strings are flagged as "verify against captured dumps," which is a fidelity instruction, not a TODO.
