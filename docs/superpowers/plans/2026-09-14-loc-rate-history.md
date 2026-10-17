# Royal Credit Line rate history

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Capture the interest rate RBC prints on every Royal Credit Line statement, so rate changes are tracked over time and interest can be attributed per person instead of split pro rata.

**Architecture:** `rbcCreditLine.ts` currently terminates parsing at the `Rate History` heading and discards the table beneath it. A new pure function reads that table; the parser returns the rows on `PdfParseResult.ratePeriods`; the commit pipeline persists them to a new `account_rate_periods` table, a period child of Account.

**Tech Stack:** Express + Sequelize (dual-dialect SQLite/Postgres), `node:test` via `tsx`, pdfjs-backed line extraction in `backend/src/import/pdf/`.

## Global Constraints

- Migrations are JavaScript in `backend/src/migrations/`, named `YYYYMMDD...-slug.js`, and must run on **both** SQLite and Postgres.
- Migration tests live in `backend/src/migrations/__tests__/`, never in `src/migrations/`.
- Unit tests are colocated beside the module under `backend/src/`.
- Rates are stored as strings with 4 decimal places (`8.9400`), never floats. Same reasoning as money: a rate is multiplied by a balance.
- **Grep `backend/test/` as well as `backend/src`** before changing any shared behaviour. `yarn workspace cashflow-backend run test` is unit-only; the integration tier is a separate required CI gate.
- Parsers must never throw on a missing optional section. A statement with no rate table still has to import its transactions.

## Ground truth

Verified against nine real statements in `~/Downloads/Credit Line Statement-0001 *.pdf`.

The rate row, page 2, as `extractPdfLines` produces it — columns separated by runs of 2+ spaces:

```
August 4, 2026   September 3, 2026   4.450 %   +4.490 %   8.940 %   172.36
```

Preceded by:

```
 Rate History for your Statement Period
 This is a history of your interest rates and the applicable interest at each rate for your statement period.
 Rate from and including   Rate to and including   Prime Rate   Premium/discount   Your Rate   Applicable Interest ($)
```

Page 1 carries the same rate in prose, on a line that also picks up marketing copy from the right-hand column:

```
Prime Rate + 4.490 % = 8.940 %       1. Scroll down to Switch to RBC, click Get Started
Current interest rate
```

All nine statements show **one** rate row at 8.940%. RBC's table is explicitly a list ("a history of your interest rates … at each rate"), so multiple rows are possible when prime moves mid-period — there is no fixture for that, so the parser must handle it by construction and a synthetic test must cover it.

`Credit Line Statement-0001 2026-01-02.pdf` is the **annual summary** format: no `From … to …` period line, no activity rows, no rate table. The existing parser docstring already declares this format unsupported. It must not crash the rate parser.

The accrued interest in the rate table is **not** the same figure as the `Interest Payment` row in the activity table — the statement says so explicitly: the payment "reflects interest charged based on your specific payment date from month to month". Across the nine statements the accrued figures are 38.63, 26.35, 18.81, 35.76, 79.19, 133.73, 146.71, 162.56, 172.36 while the charged amounts are one cycle behind. Store the accrued figure; it is the true cost of the period.

---

### Task 1: Parse the rate table

**Files:**
- Modify: `backend/src/import/pdf/rbcCreditLine.ts`
- Modify: `backend/src/import/pdf/types.ts` (add `ratePeriods` to `PdfParseResult`)
- Create: `backend/src/import/pdf/rbcCreditLineRates.test.ts`

**Interfaces:**
- Produces:
  - `interface PdfRatePeriod { fromDate: string; toDate: string; primeRate: string; premium: string; effectiveRate: string; applicableInterest: string }` (all ISO dates / fixed-4 strings) exported from `types.ts`
  - `parseRbcCreditLineRates(lines: PdfLine[]): PdfRatePeriod[]` exported from `rbcCreditLine.ts`
  - `PdfParseResult.ratePeriods?: PdfRatePeriod[]`

- [ ] **Step 1: Write the failing test**

Create `backend/src/import/pdf/rbcCreditLineRates.test.ts`. Build `PdfLine[]` fixtures by hand (`{ page, y, text }`) — synthetic fixtures legitimately omit `items`, per the note in `types.ts`.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRbcCreditLineRates } from './rbcCreditLine';
import type { PdfLine } from './types';

const line = (page: number, y: number, text: string): PdfLine => ({ page, y, text });

const HEADING = ' Rate History for your Statement Period';
const COLS = ' Rate from and including   Rate to and including   Prime Rate   Premium/discount   Your Rate   Applicable Interest ($)';

test('reads the single-rate case from a real statement row', () => {
  const rows = parseRbcCreditLineRates([
    line(2, 700, HEADING),
    line(2, 690, COLS),
    line(2, 680, 'August 4, 2026   September 3, 2026   4.450 %   +4.490 %   8.940 %   172.36'),
  ]);
  assert.deepEqual(rows, [{
    fromDate: '2026-08-04',
    toDate: '2026-09-03',
    primeRate: '4.4500',
    premium: '4.4900',
    effectiveRate: '8.9400',
    applicableInterest: '172.3600',
  }]);
});

test('reads several rate windows when prime moves mid-period', () => {
  const rows = parseRbcCreditLineRates([
    line(2, 700, HEADING),
    line(2, 690, COLS),
    line(2, 680, 'June 4, 2026   June 17, 2026   4.700 %   +4.490 %   9.190 %   60.10'),
    line(2, 670, 'June 18, 2026   July 3, 2026   4.450 %   +4.490 %   8.940 %   86.61'),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].effectiveRate, '9.1900');
  assert.equal(rows[1].fromDate, '2026-06-18');
  assert.equal(rows[1].applicableInterest, '86.6100');
});

test('handles a negative premium (a discount off prime)', () => {
  const rows = parseRbcCreditLineRates([
    line(2, 700, HEADING),
    line(2, 690, COLS),
    line(2, 680, 'May 5, 2026   June 3, 2026   4.450 %   -0.500 %   3.950 %   12.00'),
  ]);
  assert.equal(rows[0].premium, '-0.5000');
  assert.equal(rows[0].effectiveRate, '3.9500');
});

test('parses a thousands-separated interest figure', () => {
  const rows = parseRbcCreditLineRates([
    line(2, 700, HEADING),
    line(2, 690, COLS),
    line(2, 680, 'August 4, 2026   September 3, 2026   4.450 %   +4.490 %   8.940 %   1,172.36'),
  ]);
  assert.equal(rows[0].applicableInterest, '1172.3600');
});

test('stops at the next section rather than swallowing the page', () => {
  const rows = parseRbcCreditLineRates([
    line(2, 700, HEADING),
    line(2, 690, COLS),
    line(2, 680, 'August 4, 2026   September 3, 2026   4.450 %   +4.490 %   8.940 %   172.36'),
    line(2, 660, ' Important information about your account'),
    line(2, 650, 'Royal Credit Line account annual statements are now available through e-statements.'),
  ]);
  assert.equal(rows.length, 1);
});

test('the annual summary format yields no rows rather than throwing', () => {
  assert.deepEqual(parseRbcCreditLineRates([
    line(1, 700, 'Your Royal Credit Line Statement'),
    line(1, 690, 'Annual summary'),
  ]), []);
});

test('ignores the marketing copy glued onto the page-1 rate line', () => {
  // Page 1 renders "Prime Rate + 4.490 % = 8.940 %" with right-column text
  // appended. It is a cross-check, not a table row, and must not be parsed as one.
  assert.deepEqual(parseRbcCreditLineRates([
    line(1, 500, 'Prime Rate + 4.490 % = 8.940 %       1. Scroll down to Switch to RBC, click Get Started'),
    line(1, 490, 'Current interest rate'),
  ]), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/import/pdf/rbcCreditLineRates.test.ts
```

Expected: FAIL — `parseRbcCreditLineRates` is not exported.

- [ ] **Step 3: Implement**

Add `PdfRatePeriod` to `types.ts` and `ratePeriods?: PdfRatePeriod[]` to `PdfParseResult`, documented as optional so existing parsers need no retrofit.

In `rbcCreditLine.ts`, implement `parseRbcCreditLineRates`: find the `Rate History` heading, read subsequent lines on that page until a line matches no rate-row shape AND looks like a new heading, and parse each matching row. Reuse `parseLongDate` from `./dateHelpers` for the two dates rather than writing a second date parser. Return `[]` when the heading is absent.

Wire it into `rbcCreditLineParser.parse`'s return as `ratePeriods`. It must not affect the existing reconciliation gate or the transactions array.

- [ ] **Step 4: Run it to verify it passes, then the whole parser suite**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/import/pdf/rbcCreditLineRates.test.ts
cd backend && yarn tsx --import ./test/setup.ts --test src/import/pdf/*.test.ts
yarn workspace cashflow-backend run typecheck
```

- [ ] **Step 5: Verify against the ten real PDFs**

Write a throwaway script (put it in the scratchpad, not the repo) that runs the parser over every `~/Downloads/Credit Line Statement-0001 *.pdf` and prints the rate rows. Confirm nine yield exactly one row at `8.9400` and the `2026-01-02` annual summary yields none without throwing. Paste the output into your report.

- [ ] **Step 6: Commit**

```bash
git add backend/src/import/pdf/rbcCreditLine.ts backend/src/import/pdf/types.ts backend/src/import/pdf/rbcCreditLineRates.test.ts
git commit -m "feat(import): read the rate history off Royal Credit Line statements"
```

---

### Task 2: Store rate periods

**Files:**
- Create: `backend/src/migrations/20260917000001-account-rate-periods.js`
- Create: `backend/src/migrations/__tests__/accountRatePeriods.test.ts`
- Create: `backend/src/models/AccountRatePeriod.ts`
- Modify: `backend/src/models/index.ts` (register + associate)

**Interfaces:**
- Produces: `AccountRatePeriod` model with `householdId`, `accountId`, `fromDate`, `toDate`, `primeRate`, `premium`, `effectiveRate`, `applicableInterest`, `sourceStatementId`.

**Spine note for the PR:** this is reference data hanging off the **Account** primitive — the same shape as `FxRate` or `SecurityPrice`, and a period child exactly as `AccountStatement` already is. A rate window has no lifecycle of its own, so it introduces no status machine and is **not** a new primitive.

- [ ] **Step 1: Write the failing migration test**

Cover: the table is created with a unique index on `(account_id, from_date)` so re-importing the same statement cannot duplicate a window; `down` drops it cleanly. Follow the fixture style of `backend/src/migrations/__tests__/counterpartyRoleAndLoanDefault.test.ts`.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/accountRatePeriods.test.ts
```

- [ ] **Step 3: Write the migration and the model**

Columns: `id`, `household_id` (FK households, not null), `account_id` (FK accounts, not null), `from_date` DATEONLY not null, `to_date` DATEONLY not null, `prime_rate` DECIMAL(8,4), `premium` DECIMAL(8,4), `effective_rate` DECIMAL(8,4) not null, `applicable_interest` DECIMAL(14,4), `source_statement_id` (FK account_statements, nullable), timestamps. Unique index on `(account_id, from_date)`.

Model follows the house style: `field:` for snake_case, `underscored: true`, `CreationOptional` for defaulted columns. Read `backend/src/models/AccountStatement.ts` first and match it.

- [ ] **Step 4: Run it green, typecheck, commit**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/accountRatePeriods.test.ts
yarn workspace cashflow-backend run typecheck
git add backend/src/migrations/20260917000001-account-rate-periods.js backend/src/migrations/__tests__/accountRatePeriods.test.ts backend/src/models/AccountRatePeriod.ts backend/src/models/index.ts
git commit -m "feat(accounts): store the rate windows printed on a statement"
```

---

### Task 3: Persist on import

**Files:**
- Modify: `backend/src/import/commitStatementImport.ts`
- Create: `backend/src/import/commitRatePeriods.test.ts`

**Interfaces:**
- Consumes: `PdfParseResult.ratePeriods` (Task 1), `AccountRatePeriod` (Task 2).

- [ ] **Step 1: Write the failing test**

Assert that committing a parsed statement carrying `ratePeriods` writes one `AccountRatePeriod` row per window, scoped to the right household and account, linked to the created `AccountStatement`; that re-committing the same statement updates rather than duplicating (the unique index); and that a statement with no `ratePeriods` commits its transactions unaffected.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/import/commitRatePeriods.test.ts
```

- [ ] **Step 3: Implement**

In the commit path, after the `AccountStatement` is created, upsert each rate period keyed on `(accountId, fromDate)`. Rate capture must never fail the import: wrap it so a rate-persistence error is recorded as a warning on the import result rather than rolling back the transactions. Read how the existing commit path reports warnings and follow it.

- [ ] **Step 4: Verify**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/import/*.test.ts
yarn workspace cashflow-backend run typecheck
yarn workspace cashflow-backend run test
```

Grep `backend/test/integration/` for anything asserting the commit result shape and update it.

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/commitStatementImport.ts backend/src/import/commitRatePeriods.test.ts
git commit -m "feat(import): persist statement rate windows on commit"
```

---

## After this ships

Connor imports the nine monthly statements through the app's normal import flow. That fills the LoC gap from 2025-11-26 to 2026-05-08 — seven missing transactions totalling −8,800.00 — and the account balance should land on **−22,700.00**, matching the statement. The rate history lands at the same time.

Verify after import:

```sql
SELECT ROUND(SUM(amount)::numeric, 2) AS balance
FROM transactions
WHERE account_id = (SELECT id FROM accounts WHERE name = 'RBC Royal Credit Line');
-- expect -22700.00

SELECT from_date, to_date, effective_rate, applicable_interest
FROM account_rate_periods ORDER BY from_date;
-- expect nine windows, all 8.9400
```

Then Phase 2's allocator gets rewritten to use `their balance × effective_rate × days / 365` instead of splitting each charge pro rata. The difference matters: pro rata assumes the entire line funded loans to people, which is false — Connor borrows for himself too, and the remainder must stay his own cost rather than being pushed onto Caelan and Stephen.

The `2026-01-02` annual summary is not importable and should be set aside.
