# LoC interest allocator

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Attribute the line-of-credit interest Connor actually paid to the people whose outstanding balances caused it, at the rate in force on each day.

**Architecture:** `account_rate_periods` holds the rate windows read off the statements. For each window, every lending contact's outstanding principal *as of that window* earns `balance × rate × days / 365`. What is left of the window's printed interest is Connor's own borrowing cost and is charged to nobody. Allocations persist as `reimbursements` rows with `kind='interest'`, keyed to their source window so re-running recomputes.

**Tech Stack:** Express + Sequelize (dual-dialect SQLite/Postgres), `node:test` via `tsx`, Vite + React 19 + vitest, DTOs in `shared/api-types.ts`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-15-loc-interest-attribution-design.md`. Read it first.
- Money math uses integer arithmetic scaled by `10_000`, matching `computeLoanBalance` and `computeTransferNet`. Never accumulate floats.
- DTO amounts are strings fixed to 4 decimal places, dialect-independent (`Number(x).toFixed(4)`).
- Rates are `DECIMAL(8,4)` and come back as **strings on Postgres, numbers on SQLite**. This codebase runs both.
- Unit tests colocated beside the module under `backend/src/`.
- **Grep `backend/test/` as well as `backend/src`** before changing shared behaviour. The unit script does not cover the integration tier, which is a required CI gate.
- Allocated interest is derived. Re-running must recompute, never accumulate.
- Simple interest, never compounded. Interest is debited to the payment account, not capitalised.
- Design-system components are used as-is, never restyled via `className`. Tailwind variant classes are literal strings in lookup tables.
- Only a balance may carry debt language. The accrued estimate must be labelled as an estimate everywhere it appears.

## Production ground truth

`account_rate_periods` holds 16 continuous windows, 2025-07-08 → 2026-09-03, no gaps or overlaps. Rate steps: **9.4400%** through 2025-09-17, **9.1900%** through 2025-10-29, **8.9400%** since. Total printed interest across all windows: **981.76**.

Tagged principal today: `STEPHEN MASSEUR` one `loan` row of 6,700.00 dated 2026-04-15; `Caelan Iten-McGrath` thirteen `loan` rows from 2026-01-22 to 2026-07-24 totalling 24,275.00. Both contacts have `loan_default = false`, so only explicitly tagged rows count. No repayments are tagged. Nothing is tagged before 2026-01-22, so the first six windows must allocate nothing.

---

### Task 1: The window walker

**Files:**
- Create: `backend/src/contacts/interestAllocation.ts`
- Create: `backend/src/contacts/interestAllocation.test.ts`

**Interfaces:**
- Consumes: `resolveLedgerRole` from `backend/src/contacts/counterpartyRole.ts`.
- Produces:
  - `interface RateWindow { id: number; fromDate: string; toDate: string; effectiveRate: string | number; applicableInterest: string | number }`
  - `interface LedgerRow { contactId: number; date: string; amount: string | number; currency: string; counterpartyRole: string | null; loanDefault: boolean }`
  - `interface InterestAllocation { rateWindowId: number; contactId: number; currency: string; amount: string }`
  - `allocateWindowInterest(windows: RateWindow[], rows: LedgerRow[], currency: string): InterestAllocation[]`

**Method notes the tests pin:**

- A window's day count is inclusive of both endpoints: `2026-08-04 → 2026-09-03` is 31 days.
- A contact's balance is recomputed **as of each day boundary that matters**, not once per window. A loan made mid-window earns only its remaining days. Implement by walking the window day range and summing `balance_on_day × rate / 365` in integer units, or equivalently by segmenting the window at each transaction date — either is fine, but the tests below pin the mid-window case.
- Only positive balances earn interest. A contact you owe earns nothing.
- Only rows in the requested currency participate.
- Reuse `resolveLedgerRole` so loan/repayment/none matches `computeLoanBalance` exactly. Do not reimplement.
- **The bound is load-bearing:** the sum allocated for a window must never exceed that window's `applicableInterest`. If the computed total would exceed it, scale all allocations down proportionally so they sum to at most the printed figure, and never above. This is the check that catches a wrong rate or a double-counted balance.
- Output sorted by `(rateWindowId, contactId)` so re-runs are byte-identical.

- [ ] **Step 1: Write the failing test**

Create `backend/src/contacts/interestAllocation.test.ts`. Cover at minimum:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateWindowInterest } from './interestAllocation';

const w = (id: number, fromDate: string, toDate: string, effectiveRate: string, applicableInterest: string) =>
  ({ id, fromDate, toDate, effectiveRate, applicableInterest });
const loan = (contactId: number, date: string, amount: number) =>
  ({ contactId, date, amount, currency: 'CAD', counterpartyRole: 'loan' as string | null, loanDefault: false });

test('a window entirely before any loan allocates nothing', () => {
  assert.deepEqual(
    allocateWindowInterest([w(1, '2025-07-08', '2025-08-04', '9.4400', '41.3800')], [loan(4, '2026-04-15', -6700)], 'CAD'),
    [],
  );
});

test('one borrower for a whole window earns balance x rate x days / 365', () => {
  // 6700 x 8.94% x 31/365 = 50.8737...
  const out = allocateWindowInterest(
    [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
    [loan(4, '2026-04-15', -6700)],
    'CAD',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].contactId, 4);
  assert.equal(Number(out[0].amount).toFixed(2), '50.87');
});

test('a loan made mid-window earns only its remaining days', () => {
  // window 2026-04-07..2026-05-04 is 28 days; loan lands 2026-04-15, so 20 days remain
  // (15th..4th inclusive). 6700 x 8.94% x 20/365 = 32.8217...
  const out = allocateWindowInterest(
    [w(12, '2026-04-07', '2026-05-04', '8.9400', '79.1900')],
    [loan(4, '2026-04-15', -6700)],
    'CAD',
  );
  assert.equal(Number(out[0].amount).toFixed(2), '32.82');
});

test('two borrowers each earn on their own balance, not a split of the charge', () => {
  const out = allocateWindowInterest(
    [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
    [loan(4, '2026-01-01', -6700), loan(1, '2026-01-01', -24275)],
    'CAD',
  );
  const by = Object.fromEntries(out.map((a) => [a.contactId, Number(a.amount)]));
  assert.equal(by[4].toFixed(2), '50.87');
  assert.equal(by[1].toFixed(2), '184.27');
  // NOTE: this deliberately exceeds the window's 172.36 — see the next test.
});

test('allocations are scaled down so they never exceed the window\'s printed interest', () => {
  const out = allocateWindowInterest(
    [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
    [loan(4, '2026-01-01', -6700), loan(1, '2026-01-01', -24275)],
    'CAD',
  );
  const total = out.reduce((n, a) => n + Number(a.amount), 0);
  assert.ok(total <= 172.36 + 0.0001, `allocated ${total} exceeds the printed 172.36`);
  assert.equal(total.toFixed(2), '172.36', 'scaled to exactly the printed figure');
});

test('a repayment before the window reduces the balance that earns', () => {
  const out = allocateWindowInterest(
    [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
    [
      loan(4, '2026-04-15', -6700),
      { ...loan(4, '2026-05-01', 3700), counterpartyRole: 'repayment' },
    ],
    'CAD',
  );
  // 3000 x 8.94% x 31/365 = 22.78
  assert.equal(Number(out[0].amount).toFixed(2), '22.78');
});

test('a non-debt role never earns interest', () => {
  assert.deepEqual(
    allocateWindowInterest(
      [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
      [{ ...loan(4, '2026-04-15', -6700), counterpartyRole: 'purchase' }],
      'CAD',
    ),
    [],
  );
});

test('a negative balance earns nothing', () => {
  assert.deepEqual(
    allocateWindowInterest(
      [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
      [{ ...loan(4, '2026-04-15', 500), counterpartyRole: 'repayment' }],
      'CAD',
    ),
    [],
  );
});

test('the rate in force is the window\'s own rate, not the latest', () => {
  const out = allocateWindowInterest(
    [w(3, '2025-09-04', '2025-09-17', '9.4400', '26.0400')],
    [loan(1, '2025-01-01', -10000)],
    'CAD',
  );
  // 10000 x 9.44% x 14/365 = 36.21 -> scaled down to the printed 26.04
  assert.equal(Number(out[0].amount).toFixed(2), '26.04');
});

test('rates arriving as numbers (SQLite) behave identically to strings (Postgres)', () => {
  const asStr = allocateWindowInterest([w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')], [loan(4, '2026-01-01', -6700)], 'CAD');
  const asNum = allocateWindowInterest(
    [{ id: 9, fromDate: '2026-08-04', toDate: '2026-09-03', effectiveRate: 8.94, applicableInterest: 172.36 }],
    [loan(4, '2026-01-01', -6700)],
    'CAD',
  );
  assert.deepEqual(asStr, asNum);
});

test('a different currency is not allocated from a CAD window', () => {
  assert.deepEqual(
    allocateWindowInterest(
      [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
      [{ ...loan(4, '2026-01-01', -6700), currency: 'USD' }],
      'CAD',
    ),
    [],
  );
});

test('re-running over the same inputs is byte-identical', () => {
  const windows = [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')];
  const rows = [loan(4, '2026-01-01', -6700), loan(1, '2026-01-01', -24275)];
  assert.deepEqual(allocateWindowInterest(windows, rows, 'CAD'), allocateWindowInterest(windows, rows, 'CAD'));
});
```

Recompute each expected figure yourself before trusting the comment; if one disagrees with a correct implementation, fix the expectation and say so in your report rather than bending the code.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/contacts/interestAllocation.test.ts
```

Expected: FAIL — cannot find module `./interestAllocation`.

- [ ] **Step 3: Implement, then run green**

- [ ] **Step 4: Sanity-check against production shape**

Write a throwaway script **in your scratchpad, not the repo** that feeds the 16 real windows and the real tagged loans (Stephen 6,700 from 2026-04-15; Caelan's thirteen rows 2026-01-22 → 2026-07-24 totalling 24,275) through the allocator, and prints per-window and per-contact totals. Confirm: the first six windows allocate nothing, no window exceeds its printed interest, and the grand total is at most 981.76. Paste the output into your report.

- [ ] **Step 5: Commit**

```bash
git add backend/src/contacts/interestAllocation.ts backend/src/contacts/interestAllocation.test.ts
git commit -m "feat(contacts): allocate LoC interest per rate window and balance"
```

---

### Task 2: Accrued-since-last-statement

**Files:**
- Modify: `backend/src/contacts/interestAllocation.ts`
- Modify: `backend/src/contacts/interestAllocation.test.ts`

**Interfaces:**
- Produces: `accrueSinceLastWindow(args: { lastWindowEnd: string; asOf: string; currentRate: string | number; rows: LedgerRow[]; currency: string }): InterestAllocation[]` with `rateWindowId: null`.

The charged figure ends at the last statement. This estimates what has accrued since, at the current rate, so the page can show both without merging them.

- [ ] **Step 1: Write the failing test.** Cover: days counted from the day after `lastWindowEnd` through `asOf` inclusive; `asOf` before or equal to `lastWindowEnd` yields nothing; the same balance and non-debt rules as Task 1; no upper bound applies because nothing has been billed yet.

- [ ] **Step 2: Run it to verify it fails. Step 3: Implement, run green. Step 4: Commit.**

---

### Task 3: Persist and serve

**Files:**
- Create: `backend/src/contacts/runInterestAllocation.ts`
- Create: `backend/src/routes/interestAllocation.test.ts`
- Modify: `backend/src/routes/contacts.ts`, `shared/api-types.ts`

**Interfaces:**
- Produces: `runInterestAllocation({ householdId, accountId, asOf, dryRun })`; `POST /api/contacts/interest-allocation`; `ContactLedgerResponse.interestCharged: LoanBalance[]` and `.interestAccrued: LoanBalance[]`.

- Load the rate windows for the Royal Credit Line account, and every transaction carrying a `counterpartyContactId` joined to its contact's `loanDefault`.
- Run Task 1 over the windows, Task 2 for the tail.
- In one transaction: delete existing `kind='interest'` rows for those windows, then insert the new ones. Delete-then-insert is the mechanism; the unique index is the backstop.
- Charged rows persist. **The accrued estimate is computed on read, never stored** — it changes every day and storing it would make yesterday's estimate look like a billed fact.
- Mirror the `ProviderJobLog` + in-flight guard from `backend/src/import/transferContactLink.ts`.
- `dryRun` reports counts without writing.
- Keep `loanBalance` principal-only.

- [ ] Steps: failing route test → verify fails → implement → run backend suite and grep `backend/test/integration/` for `ContactLedgerResponse` assertions → commit.

---

### Task 4: The three tiles

**Files:**
- Modify: `frontend/src/pages/PeopleLedgerPage.tsx`, its test, `frontend/src/lib/api.ts`

Drill-in renders principal, interest charged, and interest accrued as separate figures with a total — never one merged number. Captions name provenance: charged is apportioned from interest actually billed; accrued is an estimate at the current rate since the last statement. Beneath them, the rate windows used, e.g. `9.440% to 2025-09-17 · 9.190% to 2025-10-29 · 8.940% since`.

Landing list shows the total per person with interest beside it, not folded in. Headline metric keeps principal and interest as separate tiles.

- [ ] Steps: failing test asserting the three figures never merge and the accrued figure is labelled an estimate → verify fails → implement → `yarn ci` with `TEST_DATABASE_URL` set → commit.

---

## After this ships

```sql
UPDATE transactions SET counterparty_role = 'loc_interest', updated_at = now()
WHERE merchant_raw ILIKE 'loan interest' AND amount < 0 AND household_id = 1;
```

Then `POST /api/contacts/interest-allocation` with `{"dryRun": true}` and check the totals before committing the write.

Expect nothing allocated before 2026-01-22 — no tagged loan existed, so that interest is Connor's own cost. That is the part the superseded pro-rata design would have charged to Caelan and Stephen.
