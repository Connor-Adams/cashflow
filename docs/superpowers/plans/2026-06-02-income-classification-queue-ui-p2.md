# Income Classification Queue UI (P2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `Classify` tax tab that lists unclassified corp→personal transfer pairs + payroll deposits and lets the user assign each a tax treatment (instant per-row save), feeding the baseline Personal T1; plus a shareholder-loan balance readout.

**Architecture:** Frontend over the existing P1 endpoints (`GET /api/tax/classification-queue`, `PATCH /api/transfers/:id/tax-treatment`) + two thin backend enrichments (account names on the queue, balance on shareholder-loans). New `ClassifyTab`/`ClassifyRow` components, a reusable `TaxTreatmentSelect`, and a `useClassificationQueue` hook. No new primitive.

**Tech Stack:** Backend: TypeScript, Express, Sequelize, `node:test` via `tsx`. Frontend: React, vitest + @testing-library/react.

**Run tests:**
- Backend (one file): `cd backend && npx tsx --import ./test/setup.ts --test test/tax/<file>.test.ts`
- Frontend (one file): `cd frontend && npx vitest run src/<path>.test.tsx`

**Spec:** `docs/superpowers/specs/2026-06-02-income-classification-queue-ui-p2-design.md`

**Commit note:** the worktree's husky `lint-staged` hook is unresolvable — commit with `git commit --no-verify`.

---

## File Structure

- **Modify** `backend/src/routes/tax.ts` — enrich `/classification-queue` response with `accountName` per leg (slim serialization); add `balance` to `GET /corp/shareholder-loans`.
- **Create** `frontend/src/components/TaxTreatmentSelect.tsx` — reusable scoped treatment `<select>`.
- **Create** `frontend/src/hooks/useClassificationQueue.ts` — fetch hook (mirrors `useReconciliation`).
- **Create** `frontend/src/pages/tax/ClassifyTab.tsx` + `ClassifyRow.tsx` — the queue UI.
- **Modify** `frontend/src/pages/TaxPage.tsx` — register the `Classify` tab.
- **Modify** `frontend/src/pages/tax/ShareholderLoanTab.tsx` — show the balance.
- **Tests:** extend `backend/test/tax/routes-classification-queue.test.ts`; add `backend/test/tax/routes-shareholder-loan-balance.test.ts`; add `frontend/src/components/TaxTreatmentSelect.test.tsx`, `frontend/src/pages/tax/ClassifyTab.test.tsx`.

---

### Task 1: Enrich `/classification-queue` response with account names

**Files:**
- Modify: `backend/src/routes/tax.ts` (the `/classification-queue` handler at ~line 25; ensure `Account` is imported)
- Test: `backend/test/tax/routes-classification-queue.test.ts` (extend existing)

- [ ] **Step 1: Add a failing assertion**

In `backend/test/tax/routes-classification-queue.test.ts`, inside the existing "returns corpDistributions and payroll" test, after the existing `corpDistributions[0].corp.id` assertions, add:

```typescript
  assert.equal(res.body.corpDistributions[0].personal.accountName, 'Personal Chk');
  assert.equal(res.body.corpDistributions[0].corp.accountName, 'Corp Chk');
  assert.equal(res.body.payroll[0].accountName, 'Personal Chk');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/routes-classification-queue.test.ts`
Expected: FAIL — `accountName` is `undefined`.

- [ ] **Step 3: Implement the enrichment**

In `backend/src/routes/tax.ts`: ensure the top imports include `Account` from `../models` (add it to the existing `import { ... } from '../models'` if missing). Replace the final `res.json({ corpDistributions, payroll });` in the `/classification-queue` handler with:

```typescript
    const allTxns = [
      ...corpDistributions.flatMap((d) => [d.personal, d.corp]),
      ...payroll,
    ] as Transaction[];
    const acctIds = Array.from(new Set(allTxns.map((t) => t.accountId)));
    const accts = acctIds.length
      ? await Account.findAll({ where: { id: acctIds } })
      : [];
    const acctName = new Map(accts.map((a) => [a.id, a.name]));
    const slim = (t: Transaction) => ({
      id: t.id,
      date: t.date,
      amount: t.amount,
      currency: t.currency,
      merchantClean: t.merchantClean,
      accountId: t.accountId,
      accountName: acctName.get(t.accountId) ?? null,
      txnType: t.txnType,
    });
    res.json({
      corpDistributions: corpDistributions.map((d) => ({
        personal: slim(d.personal as Transaction),
        corp: slim(d.corp as Transaction),
      })),
      payroll: payroll.map(slim),
    });
```

Also change the `corpDistributions` array type annotation from `Array<{ personal: unknown; corp: unknown }>` to `Array<{ personal: Transaction; corp: Transaction }>` so `.flatMap` types cleanly.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/routes-classification-queue.test.ts`
Expected: PASS (all tests, including the `.id` assertions which still hold).

- [ ] **Step 5: Typecheck + commit**

Run: `cd backend && npx tsc --noEmit` (only the pre-existing `moduleResolution=node10` deprecation allowed).
```bash
git add backend/src/routes/tax.ts backend/test/tax/routes-classification-queue.test.ts
git commit --no-verify -m "feat(tax): include accountName in classification-queue response"
```

---

### Task 2: Add `balance` to `GET /corp/shareholder-loans`

**Files:**
- Modify: `backend/src/routes/tax.ts` (the `/corp/shareholder-loans` GET handler at ~line 671)
- Test: `backend/test/tax/routes-shareholder-loan-balance.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `backend/test/tax/routes-shareholder-loan-balance.test.ts` (mirror the auth harness from `routes-classification-queue.test.ts` — read it for the exact `before`/session/cookie setup; the assertions below are the spec):

```typescript
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'crypto';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let corpEntityId: number;
let corpAccountId: number;
let householdId: number;

before(async () => {
  process.env.NODE_ENV = 'test';
  const { sequelize } = await import('../../src/db.js');
  const models = await import('../../src/models/index.js');
  await sequelize.sync({ force: true });
  const mod = await import('../../src/app.js');
  app = mod.default;
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `slbal-${Date.now()}@example.com`, displayName: 'SL', globalRole: 'user',
    passwordHash: password.hash, passwordSalt: password.salt, passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'SL HH' });
  householdId = household.id;
  await models.HouseholdMember.create({ householdId: household.id, userId: user.id, role: 'owner' });
  const corp = await models.Entity.create({
    householdId: household.id, kind: 'corp', legalName: 'Corp', jurisdiction: 'CA-ON', fiscalYearEnd: '12-31',
  } as never);
  corpEntityId = corp.id;
  const acct = await models.Account.create({
    name: 'Corp Chk', householdId: household.id, accountType: 'checking', taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  corpAccountId = acct.id;
  const token = crypto.randomBytes(32).toString('hex');
  await models.Session.create({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 86400000) });
  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${token}; Path=/`);
});

after(async () => { const { sequelize } = await import('../../src/db.js'); await sequelize.close(); });

test('GET /corp/shareholder-loans includes computed balance', async () => {
  const models = await import('../../src/models/index.js');
  await models.ShareholderLoan.create({ entityId: corpEntityId, date: '2025-01-01', kind: 'advance', amount: '10000.0000' } as never);
  await models.ShareholderLoan.create({ entityId: corpEntityId, date: '2025-02-01', kind: 'repayment', amount: '2000.0000' } as never);
  const res = await authed.get('/api/tax/corp/shareholder-loans');
  assert.equal(res.status, 200);
  assert.equal(res.body.balance, '8000');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/routes-shareholder-loan-balance.test.ts`
Expected: FAIL — `res.body.balance` is `undefined`.

- [ ] **Step 3: Implement**

In `backend/src/routes/tax.ts`: add the import `import { computeShareholderLoanBalance } from '../tax/services/shareholderLoanBalance';` near the other imports. In the `GET /corp/shareholder-loans` handler, change the empty-entity branch to `res.json({ shareholderLoans: [], balance: '0' });` and the final response to:

```typescript
    const balance = await computeShareholderLoanBalance(entity.id);
    res.json({ shareholderLoans: rows, balance: balance.toString() });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/routes-shareholder-loan-balance.test.ts`
Expected: PASS (`balance` is `'8000'`).

- [ ] **Step 5: Typecheck + commit**

Run: `cd backend && npx tsc --noEmit` (only the known deprecation).
```bash
git add backend/src/routes/tax.ts backend/test/tax/routes-shareholder-loan-balance.test.ts
git commit --no-verify -m "feat(tax): expose shareholder-loan balance on GET endpoint"
```

---

### Task 3: `TaxTreatmentSelect` component

**Files:**
- Create: `frontend/src/components/TaxTreatmentSelect.tsx`
- Test: `frontend/src/components/TaxTreatmentSelect.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/TaxTreatmentSelect.test.tsx` (mirror the render/setup style of `frontend/src/pages/RulesPage.test.tsx` if these imports differ):

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TaxTreatmentSelect } from './TaxTreatmentSelect';

describe('TaxTreatmentSelect', () => {
  it('renders only the scoped options + placeholder and fires onChange', () => {
    const onChange = vi.fn();
    render(
      <TaxTreatmentSelect
        value={null}
        options={['eligible_dividend', 'salary']}
        onChange={onChange}
        aria-label="treatment"
      />,
    );
    const select = screen.getByLabelText('treatment') as HTMLSelectElement;
    // placeholder + 2 scoped options
    expect(select.querySelectorAll('option')).toHaveLength(3);
    expect(screen.getByText('Eligible dividend')).toBeInTheDocument();
    expect(screen.getByText('Salary')).toBeInTheDocument();
    expect(screen.queryByText('Donation')).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'salary' } });
    expect(onChange).toHaveBeenCalledWith('salary');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/TaxTreatmentSelect.test.tsx`
Expected: FAIL — module `./TaxTreatmentSelect` not found.

- [ ] **Step 3: Implement the component**

Create `frontend/src/components/TaxTreatmentSelect.tsx`:

```tsx
import { TREATMENT_LABELS, type TaxTreatment } from '../lib/taxTreatment';

interface TaxTreatmentSelectProps {
  value: TaxTreatment | null;
  options: TaxTreatment[];
  onChange: (next: TaxTreatment) => void;
  placeholder?: string;
  'aria-label'?: string;
}

export function TaxTreatmentSelect({
  value,
  options,
  onChange,
  placeholder = 'Choose…',
  'aria-label': ariaLabel,
}: TaxTreatmentSelectProps) {
  return (
    <select
      aria-label={ariaLabel}
      className="text-sm"
      value={value ?? ''}
      onChange={(e) => {
        const next = e.target.value;
        if (next) onChange(next as TaxTreatment);
      }}
    >
      <option value="" disabled>
        {placeholder}
      </option>
      {options.map((t) => (
        <option key={t} value={t}>
          {TREATMENT_LABELS[t]}
        </option>
      ))}
    </select>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/TaxTreatmentSelect.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/TaxTreatmentSelect.tsx frontend/src/components/TaxTreatmentSelect.test.tsx
git commit --no-verify -m "feat(tax): reusable TaxTreatmentSelect component"
```

---

### Task 4: `useClassificationQueue` hook

**Files:**
- Create: `frontend/src/hooks/useClassificationQueue.ts`

- [ ] **Step 1: Implement the hook** (mirrors `frontend/src/hooks/useReconciliation.ts`, adds `reload` + an `entityId` guard)

Create `frontend/src/hooks/useClassificationQueue.ts`:

```typescript
import { useCallback, useEffect, useState } from 'react';
import { getJson } from '@/lib/api';

export interface QueueLeg {
  id: number;
  date: string;
  amount: string;
  currency: string;
  merchantClean: string | null;
  accountId: number;
  accountName: string | null;
  txnType: string;
}

export interface ClassificationQueue {
  corpDistributions: { personal: QueueLeg; corp: QueueLeg }[];
  payroll: QueueLeg[];
}

interface UseClassificationQueueResult {
  data: ClassificationQueue | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export function useClassificationQueue(
  entityId: number | null,
  year: number,
): UseClassificationQueueResult {
  const [data, setData] = useState<ClassificationQueue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (entityId == null) {
      setData(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getJson<ClassificationQueue>(
      `/api/tax/classification-queue?entityId=${entityId}&year=${year}`,
    )
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(String((e as Error)?.message ?? e));
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [entityId, year, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, reload };
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd frontend && npx tsc -b 2>&1 | grep -iE "useClassificationQueue|error TS" | grep -v "baseUrl\|moduleResolution"` (expect empty).
```bash
git add frontend/src/hooks/useClassificationQueue.ts
git commit --no-verify -m "feat(tax): useClassificationQueue hook"
```

---

### Task 5: `ClassifyRow` + `ClassifyTab` + tab registration

**Files:**
- Create: `frontend/src/pages/tax/ClassifyRow.tsx`
- Create: `frontend/src/pages/tax/ClassifyTab.tsx`
- Modify: `frontend/src/pages/TaxPage.tsx` (add the tab)
- Test: `frontend/src/pages/tax/ClassifyTab.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/tax/ClassifyTab.test.tsx`. Mock `@/lib/api` and the entities + queue hooks so the tab renders deterministically. Mirror `RulesPage.test.tsx` for any project-specific render setup.

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const patchJson = vi.fn().mockResolvedValue({});
vi.mock('@/lib/api', () => ({ patchJson: (...a: unknown[]) => patchJson(...a), getJson: vi.fn() }));

const reload = vi.fn();
let queueData: unknown = {
  corpDistributions: [
    {
      personal: { id: 11, date: '2025-04-01', amount: '20000', currency: 'CAD', merchantClean: 'Owner transfer', accountId: 1, accountName: 'Personal Chk', txnType: 'transfer' },
      corp: { id: 12, date: '2025-04-01', amount: '-20000', currency: 'CAD', merchantClean: 'Owner transfer', accountId: 2, accountName: 'Corp Chk', txnType: 'transfer' },
    },
  ],
  payroll: [
    { id: 21, date: '2025-07-01', amount: '3000', currency: 'CAD', merchantClean: 'Employer', accountId: 1, accountName: 'Personal Chk', txnType: 'income' },
  ],
};
vi.mock('../../hooks/useClassificationQueue', () => ({
  useClassificationQueue: () => ({ data: queueData, error: null, loading: false, reload }),
}));
vi.mock('../../hooks/useTaxEntities', () => ({
  useTaxEntities: () => ({ entities: [{ id: 5, kind: 'personal' }], error: null }),
}));

import { ClassifyTab } from './ClassifyTab';

describe('ClassifyTab', () => {
  beforeEach(() => { patchJson.mockClear(); reload.mockClear(); });

  it('renders corp + payroll sections and classifies a row (instant save + move)', async () => {
    render(<ClassifyTab year={2025} />);
    expect(screen.getByText(/Corp → personal/i)).toBeInTheDocument();
    expect(screen.getByText('Personal Chk')).toBeInTheDocument();
    expect(screen.getByText(/Payroll/i)).toBeInTheDocument();

    const select = screen.getByLabelText('treatment for txn 11') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'non_eligible_dividend' } });

    await waitFor(() => {
      expect(patchJson).toHaveBeenCalledWith('/api/transfers/11/tax-treatment', {
        taxTreatmentOverride: 'non_eligible_dividend',
      });
    });
    // row moves to Classified (an Undo control appears)
    expect(await screen.findByText(/Undo/i)).toBeInTheDocument();
  });

  it('shows an empty state when nothing is unclassified', () => {
    queueData = { corpDistributions: [], payroll: [] };
    render(<ClassifyTab year={2025} />);
    expect(screen.getByText(/No unclassified income/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/tax/ClassifyTab.test.tsx`
Expected: FAIL — modules `./ClassifyTab` / `./ClassifyRow` not found.

- [ ] **Step 3: Implement `ClassifyRow`**

Create `frontend/src/pages/tax/ClassifyRow.tsx`:

```tsx
import { useState } from 'react';
import { patchJson } from '@/lib/api';
import { TaxTreatmentSelect } from '../../components/TaxTreatmentSelect';
import type { TaxTreatment } from '../../lib/taxTreatment';
import type { QueueLeg } from '../../hooks/useClassificationQueue';

const CORP_OPTIONS: TaxTreatment[] = [
  'eligible_dividend',
  'non_eligible_dividend',
  'salary',
  'loan_advance',
  'loan_repayment',
  'not_income',
];
const PAYROLL_OPTIONS: TaxTreatment[] = ['employment_income', 'not_income'];

interface ClassifyRowProps {
  /** The transaction to PATCH (personal leg for a pair; the txn for payroll). */
  targetId: number;
  kind: 'corp' | 'payroll';
  primary: QueueLeg;
  counter?: QueueLeg; // the corp leg, when kind === 'corp'
  onClassified: (targetId: number, treatment: TaxTreatment) => void;
}

export function ClassifyRow({ targetId, kind, primary, counter, onClassified }: ClassifyRowProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = kind === 'corp' ? CORP_OPTIONS : PAYROLL_OPTIONS;

  async function choose(next: TaxTreatment) {
    setError(null);
    setBusy(true);
    try {
      await patchJson(`/api/transfers/${targetId}/tax-treatment`, { taxTreatmentOverride: next });
      onClassified(targetId, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const flow =
    kind === 'corp' && counter
      ? `${counter.accountName ?? 'Corp'} → ${primary.accountName ?? 'Personal'}`
      : (primary.accountName ?? '');

  return (
    <li className="flex items-center gap-3 py-2">
      <span className="w-20 text-sm">{primary.date}</span>
      <span className="w-24 text-sm font-semibold">${primary.amount}</span>
      <span className="flex-1 text-sm">{flow}{primary.merchantClean ? ` · ${primary.merchantClean}` : ''}</span>
      <TaxTreatmentSelect
        value={null}
        options={options}
        onChange={choose}
        placeholder="Treatment…"
        aria-label={`treatment for txn ${targetId}`}
      />
      {busy && <span className="muted text-xs">Saving…</span>}
      {error && <span className="error text-xs" role="alert">{error}</span>}
    </li>
  );
}
```

- [ ] **Step 4: Implement `ClassifyTab`**

Create `frontend/src/pages/tax/ClassifyTab.tsx`:

```tsx
import { useState } from 'react';
import { patchJson } from '@/lib/api';
import { useTaxEntities } from '../../hooks/useTaxEntities';
import { useClassificationQueue } from '../../hooks/useClassificationQueue';
import { TREATMENT_LABELS, type TaxTreatment } from '../../lib/taxTreatment';
import { ClassifyRow } from './ClassifyRow';

interface ClassifiedEntry {
  targetId: number;
  treatment: TaxTreatment;
  label: string;
}

export function ClassifyTab({ year }: { year: number }) {
  const { entities, error: entitiesError } = useTaxEntities();
  const personalEntity = entities?.find((e) => e.kind === 'personal') ?? null;
  const { data, error, loading, reload } = useClassificationQueue(personalEntity?.id ?? null, year);
  const [classified, setClassified] = useState<ClassifiedEntry[]>([]);

  if (entitiesError) return <p className="error">Failed to load entities: {entitiesError}</p>;
  if (!personalEntity && entities !== null) return <p className="muted">No personal entity for this household.</p>;
  if (loading || data === null) return <p className="muted">Loading…</p>;
  if (error) return <p className="error">Failed to load queue: {error}</p>;

  function onClassified(targetId: number, treatment: TaxTreatment, label: string) {
    setClassified((prev) => [{ targetId, treatment, label }, ...prev]);
  }
  async function undo(entry: ClassifiedEntry) {
    await patchJson(`/api/transfers/${entry.targetId}/tax-treatment`, { taxTreatmentOverride: null });
    setClassified((prev) => prev.filter((c) => c.targetId !== entry.targetId));
    reload();
  }

  const doneIds = new Set(classified.map((c) => c.targetId));
  const corp = data.corpDistributions.filter((d) => !doneIds.has(d.personal.id));
  const payroll = data.payroll.filter((p) => !doneIds.has(p.id));
  const nothing = corp.length === 0 && payroll.length === 0 && classified.length === 0;

  return (
    <div>
      <h3>Classify income — {year}</h3>
      {nothing && <p className="muted">No unclassified income for {year}.</p>}

      {corp.length > 0 && (
        <section>
          <h4>Corp → personal · {corp.length}</h4>
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {corp.map((d) => (
              <ClassifyRow
                key={d.personal.id}
                targetId={d.personal.id}
                kind="corp"
                primary={d.personal}
                counter={d.corp}
                onClassified={(id, t) => onClassified(id, t, `$${d.personal.amount} → ${TREATMENT_LABELS[t]}`)}
              />
            ))}
          </ul>
        </section>
      )}

      {payroll.length > 0 && (
        <section>
          <h4>Payroll · {payroll.length}</h4>
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {payroll.map((p) => (
              <ClassifyRow
                key={p.id}
                targetId={p.id}
                kind="payroll"
                primary={p}
                onClassified={(id, t) => onClassified(id, t, `$${p.amount} → ${TREATMENT_LABELS[t]}`)}
              />
            ))}
          </ul>
        </section>
      )}

      {classified.length > 0 && (
        <section>
          <h4>Classified · {classified.length}</h4>
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {classified.map((c) => (
              <li key={c.targetId} className="flex items-center gap-3 py-2">
                <span aria-hidden>✓</span>
                <span className="flex-1 text-sm">{c.label}</span>
                <button type="button" className="text-sm underline" onClick={() => void undo(c)}>
                  Undo
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Register the tab in `frontend/src/pages/TaxPage.tsx`**

Add `import { ClassifyTab } from './tax/ClassifyTab';` with the other tab imports. In the `TABS` array, add after the `reconciliation` entry:

```typescript
  { value: 'classify', label: 'Classify' },
```

In the conditional render block (where other tabs render, e.g. `{tab === 'reconciliation' && <ReconciliationTab year={year} />}`), add:

```tsx
      {tab === 'classify' && <ClassifyTab year={year} />}
```

(Match the exact `tab === …` / active-value variable name used by the surrounding entries.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/pages/tax/ClassifyTab.test.tsx`
Expected: PASS (both tests).

- [ ] **Step 7: Typecheck + commit**

Run: `cd frontend && npx tsc -b 2>&1 | grep -iE "Classify|error TS" | grep -v "baseUrl\|moduleResolution\|vite.config"` (expect empty).
```bash
git add frontend/src/pages/tax/ClassifyRow.tsx frontend/src/pages/tax/ClassifyTab.tsx frontend/src/pages/TaxPage.tsx frontend/src/pages/tax/ClassifyTab.test.tsx
git commit --no-verify -m "feat(tax): Classify tab — corp/payroll classification queue UI"
```

---

### Task 6: Shareholder-loan balance readout

**Files:**
- Modify: `frontend/src/pages/tax/ShareholderLoanTab.tsx`
- Modify: `frontend/src/hooks/useShareholderLoans.ts` (surface `balance` from the response)

- [ ] **Step 1: Surface `balance` in the hook**

Read `frontend/src/hooks/useShareholderLoans.ts`. It fetches `{ shareholderLoans }`; extend its response type + state to also capture `balance: string` (default `'0'`), returning it alongside the existing data. Concretely: change the `getJson<{ shareholderLoans: ShareholderLoan[] }>` generic to `getJson<{ shareholderLoans: ShareholderLoan[]; balance: string }>`, store `balance` in state, and include `balance` in the returned object (default `'0'` before load).

- [ ] **Step 2: Display it in `ShareholderLoanTab.tsx`**

Read `frontend/src/pages/tax/ShareholderLoanTab.tsx`. Below the page heading (above the entries table), render the balance from the hook:

```tsx
      <p className="muted">Shareholder-loan balance: <strong>${balance}</strong></p>
```

(Destructure `balance` from the `useShareholderLoans()` call. Use the currency/format style already present in that file if it formats money; otherwise the raw string is fine for P2.)

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc -b 2>&1 | grep -iE "ShareholderLoan|error TS" | grep -v "baseUrl\|moduleResolution\|vite.config"` (expect empty).

- [ ] **Step 4: Manual verify + commit**

The backend `balance` field (Task 2) feeds this. Confirm the tab renders without type errors.
```bash
git add frontend/src/hooks/useShareholderLoans.ts frontend/src/pages/tax/ShareholderLoanTab.tsx
git commit --no-verify -m "feat(tax): show shareholder-loan balance on Shareholder Loans tab"
```

---

## Self-Review

**Spec coverage:**
- New Classify tab + registration → Task 5. ✓
- `useClassificationQueue` hook → Task 4. ✓
- `TaxTreatmentSelect` (reusable scoped picker) → Task 3. ✓
- Scoped options (corp vs payroll) → Task 5 (`CORP_OPTIONS`/`PAYROLL_OPTIONS` in ClassifyRow). ✓
- Instant per-row save + Classified section + Undo → Task 5 (ClassifyTab/ClassifyRow). ✓
- Empty state → Task 5. ✓
- Queue `accountName` enrichment → Task 1. ✓
- Loan balance exposure (BE) + display (FE) → Task 2 + Task 6. ✓
- Edge cases (PATCH failure inline error, classified-elsewhere absent) → ClassifyRow error state (Task 5); absence is inherent to the queue filter (no code). ✓

**Placeholder scan:** No TBD/TODO. Tasks 5/6 reference "match the surrounding `tab === …` variable" and "read the file" for ShareholderLoanTab/useShareholderLoans — these are concrete adaptations to existing files whose exact current contents the engineer must mirror; the required change (add `balance`, add a tab case) is fully specified with code. Acceptable.

**Type consistency:** `QueueLeg`/`ClassificationQueue` defined in Task 4 are imported by ClassifyRow/ClassifyTab (Task 5). `TaxTreatment` from `../lib/taxTreatment` consistent across Tasks 3/5. PATCH path `/api/transfers/:id/tax-treatment` + body `{ taxTreatmentOverride }` consistent (Task 5 row + undo, matches the P1 endpoint). `balance` is a string in BE (Task 2 `balance.toString()`) and FE (Task 6) — consistent.

**Deferred to P3 (explicit):** auto-suggest, bulk apply, per-counterparty defaults, capital_dividend, T4/T5 gen, DRY-ing the 3 existing hand-rolled selects, per-member queue visibility.
