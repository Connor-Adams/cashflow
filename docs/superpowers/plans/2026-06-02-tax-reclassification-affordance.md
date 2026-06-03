# Tax Reclassification Affordance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give users an in-product way to see already-classified corp↔personal transfers + payroll and change or clear their tax treatment, via a new "Classified" tab in the tax UI.

**Architecture:** A new *view + behavior* on the **Transaction** primitive — no new table, no new status machine. Backend: extend `GET /api/tax/classification-queue` with `?status=classified` (inverse of the existing `taxTreatmentOverride IS NULL` filter) and surface the current treatment in the serializer. Frontend: a `ClassifiedTab` + `ClassifiedRow` mirroring the existing `ClassifyTab`/`ClassifyRow`, reusing `TaxTreatmentSelect` and the **both-legs-correct** `PATCH /api/transfers/:id/tax-treatment` endpoint (which atomically syncs both legs of a linked pair; `null` clears).

**Tech Stack:** Backend — Express + Sequelize, tests via `node:test` + `supertest` + `sequelize.sync({force:true})`. Frontend — React + Tailwind v4, tests via `vitest` + `@testing-library/react`.

**Spec:** `docs/superpowers/specs/2026-06-02-tax-reclassification-affordance-design.md`

---

## File Structure

**Backend (modify):**
- `backend/src/routes/tax.ts` — `GET /classification-queue` handler gains `status` param + `taxTreatmentOverride` in `slim()`.
- `backend/test/tax/routes-classification-queue.test.ts` — add classified-mode + regression + invalid-status tests.

**Frontend (modify):**
- `frontend/src/hooks/useClassificationQueue.ts` — add `status` param; add `taxTreatmentOverride` to `QueueLeg`.
- `frontend/src/lib/taxTreatment.ts` — export shared `CORP_OPTIONS` / `PAYROLL_OPTIONS`.
- `frontend/src/pages/tax/ClassifyRow.tsx` — import the shared option lists instead of local copies.
- `frontend/src/pages/TaxPage.tsx` — register the `classified` tab.

**Frontend (create):**
- `frontend/src/hooks/useClassificationQueue.test.ts` — hook URL test.
- `frontend/src/pages/tax/ClassifiedRow.tsx` — inline reclass/clear row.
- `frontend/src/pages/tax/ClassifiedTab.tsx` — the tab.
- `frontend/src/pages/tax/ClassifiedTab.test.tsx` — tab + row behavior.

---

## Task 1: Backend — `?status=classified` on the classification queue

**Files:**
- Modify: `backend/src/routes/tax.ts:27-112` (the `GET /classification-queue` handler)
- Test: `backend/test/tax/routes-classification-queue.test.ts` (append tests after line 288)

- [ ] **Step 1: Write the failing tests**

Append these three tests to the END of `backend/test/tax/routes-classification-queue.test.ts` (after the final `});` on line 288, before EOF):

```typescript
test('GET /api/tax/classification-queue?status=classified returns only classified items with treatment populated', async () => {
  const models = await import('../../src/models/index.js');
  const ts = Date.now();

  // Classified corp→personal PAIR: both legs override = non_eligible_dividend.
  const pLeg = await models.Transaction.create({
    accountId: personalAccountId, householdId, entityId: personalEntityId,
    date: '2025-03-10', amount: '8000', currency: 'CAD', txnType: 'transfer',
    visibility: 'shared', taxTreatmentOverride: 'non_eligible_dividend',
    merchantRaw: 'DIV', merchantClean: 'DIV', importBatch: 'b',
    sourceRowFingerprint: `fp-cp-${ts}`, sourceIdentityFingerprint: `sif-cp-${ts}`,
  } as never);
  const cLeg = await models.Transaction.create({
    accountId: corpAccountId, householdId, entityId: corpEntityId,
    date: '2025-03-10', amount: '-8000', currency: 'CAD', txnType: 'transfer',
    visibility: 'shared', taxTreatmentOverride: 'non_eligible_dividend',
    merchantRaw: 'DIV', merchantClean: 'DIV', importBatch: 'b',
    sourceRowFingerprint: `fp-cc-${ts}`, sourceIdentityFingerprint: `sif-cc-${ts}`,
  } as never);
  await pLeg.update({ linkedTransactionId: cLeg.id });
  await cLeg.update({ linkedTransactionId: pLeg.id });

  // Classified payroll deposit.
  const payClassified = await models.Transaction.create({
    accountId: personalAccountId, householdId, entityId: personalEntityId,
    date: '2025-08-01', amount: '3500', currency: 'CAD', txnType: 'income',
    visibility: 'shared', taxTreatmentOverride: 'employment_income',
    merchantRaw: 'PAY2', merchantClean: 'PAY2', importBatch: 'b',
    sourceRowFingerprint: `fp-pay2-${ts}`, sourceIdentityFingerprint: `sif-pay2-${ts}`,
  } as never);

  const res = await authed.get(
    `/api/tax/classification-queue?entityId=${personalEntityId}&year=2025&status=classified`,
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const cpIds = res.body.corpDistributions.map((d: { personal: { id: number } }) => d.personal.id);
  assert.ok(cpIds.includes(pLeg.id), 'classified pair must appear in classified mode');
  const cp = res.body.corpDistributions.find(
    (d: { personal: { id: number } }) => d.personal.id === pLeg.id,
  );
  assert.equal(cp.personal.taxTreatmentOverride, 'non_eligible_dividend');
  assert.equal(cp.corp.taxTreatmentOverride, 'non_eligible_dividend');

  const payIds = res.body.payroll.map((p: { id: number }) => p.id);
  assert.ok(payIds.includes(payClassified.id), 'classified payroll must appear');

  // No null-override (unclassified) item may leak into classified mode.
  for (const d of res.body.corpDistributions) {
    assert.ok(d.personal.taxTreatmentOverride != null, 'classified mode: personal leg must have a treatment');
    assert.ok(d.corp.taxTreatmentOverride != null, 'classified mode: corp leg must have a treatment');
  }
  for (const p of res.body.payroll) {
    assert.ok(p.taxTreatmentOverride != null, 'classified payroll must have a treatment');
  }
});

test('default/unclassified mode returns only null-override items', async () => {
  const res = await authed.get(
    `/api/tax/classification-queue?entityId=${personalEntityId}&year=2025`,
  );
  assert.equal(res.status, 200);
  for (const d of res.body.corpDistributions) {
    assert.equal(d.personal.taxTreatmentOverride, null, 'unclassified mode: only null-override legs');
  }
  for (const p of res.body.payroll) {
    assert.equal(p.taxTreatmentOverride, null, 'unclassified mode: only null-override payroll');
  }
});

test('GET /api/tax/classification-queue rejects an unknown status with 400', async () => {
  const res = await authed.get(
    `/api/tax/classification-queue?entityId=${personalEntityId}&year=2025&status=bogus`,
  );
  assert.equal(res.status, 400, JSON.stringify(res.body));
});

test('classified mode excludes another member private classified pair', async () => {
  const models = await import('../../src/models/index.js');
  const ts = Date.now();
  const otherUser = await models.User.create({
    email: `cq-cls-other-${ts}@example.com`, displayName: 'Other Cls', globalRole: 'user',
    passwordHash: 'x', passwordSalt: 'x', passwordParams: '{}',
  } as never);
  const pPriv = await models.Transaction.create({
    accountId: personalAccountId, householdId, entityId: personalEntityId,
    date: '2025-10-01', amount: '6000', currency: 'CAD', txnType: 'transfer',
    visibility: 'private', createdByUserId: otherUser.id, taxTreatmentOverride: 'eligible_dividend',
    merchantRaw: 'PRIVCLS', merchantClean: 'PRIVCLS', importBatch: 'b',
    sourceRowFingerprint: `fp-privcls-${ts}`, sourceIdentityFingerprint: `sif-privcls-${ts}`,
  } as never);
  const cPriv = await models.Transaction.create({
    accountId: corpAccountId, householdId, entityId: corpEntityId,
    date: '2025-10-01', amount: '-6000', currency: 'CAD', txnType: 'transfer',
    visibility: 'private', createdByUserId: otherUser.id, taxTreatmentOverride: 'eligible_dividend',
    linkedTransactionId: pPriv.id,
    merchantRaw: 'PRIVCLS', merchantClean: 'PRIVCLS', importBatch: 'b',
    sourceRowFingerprint: `fp-privclsc-${ts}`, sourceIdentityFingerprint: `sif-privclsc-${ts}`,
  } as never);
  await pPriv.update({ linkedTransactionId: cPriv.id });
  const res = await authed.get(
    `/api/tax/classification-queue?entityId=${personalEntityId}&year=2025&status=classified`,
  );
  assert.equal(res.status, 200);
  const ids = res.body.corpDistributions.map((d: { personal: { id: number } }) => d.personal.id);
  assert.ok(!ids.includes(pPriv.id), 'another member private classified pair must be excluded');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/routes-classification-queue.test.ts`
Expected: the new `status=classified` test FAILS (classified items not returned — current filter is `taxTreatmentOverride: null`), and `taxTreatmentOverride` is `undefined` on each leg (not yet in `slim()`). The invalid-status test FAILS (currently returns 200, not 400). (The visibility test may pass incidentally since the private pair is excluded by the as-yet-unchanged null filter too — it locks in the behavior for classified mode.)

- [ ] **Step 3: Implement the handler changes**

In `backend/src/routes/tax.ts`, in the `GET /classification-queue` handler:

(a) Add status parsing immediately AFTER the entityId/year `400` guard (after the block ending at line 35, before `const personal = await Entity.findByPk(entityId);`):

```typescript
    const statusRaw = req.query.status;
    const status = statusRaw === undefined ? 'unclassified' : String(statusRaw);
    if (status !== 'unclassified' && status !== 'classified') {
      res.status(400).json({ error: 'invalid status' });
      return;
    }
    const overrideWhere = status === 'classified' ? { [Op.ne]: null } : null;
```

(b) In the `personalLegs` query, replace:

```typescript
        taxTreatmentOverride: null,
```
with:
```typescript
        taxTreatmentOverride: overrideWhere,
```

(c) In the `payroll` query, replace:

```typescript
        taxTreatmentOverride: null,
```
with:
```typescript
        taxTreatmentOverride: overrideWhere,
```

(d) In the `slim` serializer, add the field (after the `txnType: t.txnType,` line):

```typescript
      taxTreatmentOverride: t.taxTreatmentOverride,
```

If TypeScript complains about `overrideWhere`'s type in the `where` clause, cast at use site: `taxTreatmentOverride: overrideWhere as never,` (mirrors the codebase's existing `as never` casts on Sequelize where/create calls).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/routes-classification-queue.test.ts`
Expected: all tests PASS (the original 5 + the 4 new ones).

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/tax.ts backend/test/tax/routes-classification-queue.test.ts
git commit --no-verify -m "feat(tax): classification-queue ?status=classified inverse filter"
```

(`--no-verify`: the pre-commit husky hook shells out to `lint-staged`, which is not installed in this worktree; lint is run explicitly in Task 7.)

---

## Task 2: Frontend — hook gains `status` param + `taxTreatmentOverride`

**Files:**
- Modify: `frontend/src/hooks/useClassificationQueue.ts`
- Test: `frontend/src/hooks/useClassificationQueue.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/hooks/useClassificationQueue.test.ts`:

```typescript
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useClassificationQueue } from './useClassificationQueue'
import * as api from '@/lib/api'

void React

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn() }
})

beforeEach(() => { vi.clearAllMocks() })

describe('useClassificationQueue', () => {
  it('requests the classified queue when status=classified', async () => {
    vi.mocked(api.getJson).mockResolvedValue({ corpDistributions: [], payroll: [] })
    const { result } = renderHook(() => useClassificationQueue(5, 2025, 'classified'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(api.getJson).toHaveBeenCalledWith(
      '/api/tax/classification-queue?entityId=5&year=2025&status=classified',
    )
  })

  it('defaults to the unclassified queue', async () => {
    vi.mocked(api.getJson).mockResolvedValue({ corpDistributions: [], payroll: [] })
    const { result } = renderHook(() => useClassificationQueue(5, 2025))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(api.getJson).toHaveBeenCalledWith(
      '/api/tax/classification-queue?entityId=5&year=2025&status=unclassified',
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/hooks/useClassificationQueue.test.ts`
Expected: FAIL — the requested URL has no `&status=...` suffix (and `useClassificationQueue` rejects a 3rd arg in TS, surfacing at test-run/type level).

- [ ] **Step 3: Implement the hook changes**

In `frontend/src/hooks/useClassificationQueue.ts`:

(a) Add the type import at the top (after the `getJson` import on line 2):

```typescript
import type { TaxTreatment } from '../lib/taxTreatment';
```

(b) In the `QueueLeg` interface, add the field (after `txnType: string;`):

```typescript
  taxTreatmentOverride: TaxTreatment | null;
```

(c) Add the third parameter to the function signature:

```typescript
export function useClassificationQueue(
  entityId: number | null,
  year: number,
  status: 'unclassified' | 'classified' = 'unclassified',
): UseClassificationQueueResult {
```

(d) Append `status` to the request URL:

```typescript
    getJson<ClassificationQueue>(
      `/api/tax/classification-queue?entityId=${entityId}&year=${year}&status=${status}`,
    )
```

(e) Add `status` to the effect dependency array:

```typescript
  }, [entityId, year, status, nonce]);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/hooks/useClassificationQueue.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useClassificationQueue.ts frontend/src/hooks/useClassificationQueue.test.ts
git commit --no-verify -m "feat(tax): useClassificationQueue status param + treatment field"
```

---

## Task 3: Frontend — extract shared treatment option lists (DRY)

**Files:**
- Modify: `frontend/src/lib/taxTreatment.ts`
- Modify: `frontend/src/pages/tax/ClassifyRow.tsx`

This is a no-behavior-change refactor; the existing `ClassifyTab.test.tsx` and `TaxTreatmentSelect.test.tsx` are the safety net.

- [ ] **Step 1: Confirm the safety-net tests pass before refactoring**

Run: `cd frontend && npx vitest run src/pages/tax/ClassifyTab.test.tsx src/components/TaxTreatmentSelect.test.tsx`
Expected: PASS.

- [ ] **Step 2: Add the shared option lists**

Append to `frontend/src/lib/taxTreatment.ts`:

```typescript

export const CORP_OPTIONS: TaxTreatment[] = [
  'eligible_dividend',
  'non_eligible_dividend',
  'salary',
  'loan_advance',
  'loan_repayment',
  'not_income',
]

export const PAYROLL_OPTIONS: TaxTreatment[] = ['employment_income', 'not_income']
```

- [ ] **Step 3: Use the shared lists in ClassifyRow**

In `frontend/src/pages/tax/ClassifyRow.tsx`:

Replace the type-only import on line 4:
```typescript
import type { TaxTreatment } from '../../lib/taxTreatment';
```
with:
```typescript
import { CORP_OPTIONS, PAYROLL_OPTIONS, type TaxTreatment } from '../../lib/taxTreatment';
```

Then DELETE the local constant block (the `const CORP_OPTIONS` and `const PAYROLL_OPTIONS` declarations, currently lines 8-16). Leave the rest of the file (including `const options = kind === 'corp' ? CORP_OPTIONS : PAYROLL_OPTIONS;`) unchanged — it now resolves to the imported lists.

- [ ] **Step 4: Run the safety-net tests to verify they still pass**

Run: `cd frontend && npx vitest run src/pages/tax/ClassifyTab.test.tsx src/components/TaxTreatmentSelect.test.tsx`
Expected: PASS (unchanged behavior).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/taxTreatment.ts frontend/src/pages/tax/ClassifyRow.tsx
git commit --no-verify -m "refactor(tax): hoist CORP/PAYROLL treatment options to taxTreatment.ts"
```

---

## Task 4: Frontend — ClassifiedTab + ClassifiedRow

**Files:**
- Create: `frontend/src/pages/tax/ClassifiedRow.tsx`
- Create: `frontend/src/pages/tax/ClassifiedTab.tsx`
- Test: `frontend/src/pages/tax/ClassifiedTab.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/tax/ClassifiedTab.test.tsx`:

```tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

void React;

const patchJson = vi.fn().mockResolvedValue({});
vi.mock('@/lib/api', () => ({ patchJson: (...a: unknown[]) => patchJson(...a), getJson: vi.fn() }));

const reload = vi.fn();
const CLASSIFIED_QUEUE = {
  corpDistributions: [
    {
      personal: { id: 11, date: '2025-04-01', amount: '20000', currency: 'CAD', merchantClean: 'Owner transfer', accountId: 1, accountName: 'Personal Chk', txnType: 'transfer', taxTreatmentOverride: 'non_eligible_dividend' },
      corp: { id: 12, date: '2025-04-01', amount: '-20000', currency: 'CAD', merchantClean: 'Owner transfer', accountId: 2, accountName: 'Corp Chk', txnType: 'transfer', taxTreatmentOverride: 'non_eligible_dividend' },
    },
  ],
  payroll: [
    { id: 21, date: '2025-07-01', amount: '3000', currency: 'CAD', merchantClean: 'Employer', accountId: 1, accountName: 'Personal Chk', txnType: 'income', taxTreatmentOverride: 'employment_income' },
  ],
};
let queueData: unknown = CLASSIFIED_QUEUE;
vi.mock('../../hooks/useClassificationQueue', () => ({
  useClassificationQueue: () => ({ data: queueData, error: null, loading: false, reload }),
}));
vi.mock('../../hooks/useTaxEntities', () => ({
  useTaxEntities: () => ({ entities: [{ id: 5, kind: 'personal' }], error: null }),
}));

import { ClassifiedTab } from './ClassifiedTab';

describe('ClassifiedTab', () => {
  beforeEach(() => { patchJson.mockClear(); reload.mockClear(); queueData = CLASSIFIED_QUEUE; });

  it('renders classified rows with the current treatment pre-selected', () => {
    render(<ClassifiedTab year={2025} />);
    const corpSelect = screen.getByLabelText('treatment for txn 11') as HTMLSelectElement;
    expect(corpSelect.value).toBe('non_eligible_dividend');
    const paySelect = screen.getByLabelText('treatment for txn 21') as HTMLSelectElement;
    expect(paySelect.value).toBe('employment_income');
  });

  it('reclassifies a corp pair to a new treatment via the both-legs transfers endpoint and reloads', async () => {
    render(<ClassifiedTab year={2025} />);
    const select = screen.getByLabelText('treatment for txn 11') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'loan_advance' } });
    await waitFor(() => {
      expect(patchJson).toHaveBeenCalledWith('/api/transfers/11/tax-treatment', { taxTreatmentOverride: 'loan_advance' });
    });
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('clears a treatment (sends it back to the queue) by selecting the empty option', async () => {
    render(<ClassifiedTab year={2025} />);
    const select = screen.getByLabelText('treatment for txn 21') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => {
      expect(patchJson).toHaveBeenCalledWith('/api/transfers/21/tax-treatment', { taxTreatmentOverride: null });
    });
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('shows an empty state when nothing is classified', () => {
    queueData = { corpDistributions: [], payroll: [] };
    render(<ClassifiedTab year={2025} />);
    expect(screen.getByText(/No classified income/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/tax/ClassifiedTab.test.tsx`
Expected: FAIL — `Cannot find module './ClassifiedTab'`.

- [ ] **Step 3: Create ClassifiedRow**

Create `frontend/src/pages/tax/ClassifiedRow.tsx`:

```tsx
import { useState } from 'react';
import { patchJson } from '@/lib/api';
import { TaxTreatmentSelect } from '../../components/TaxTreatmentSelect';
import { CORP_OPTIONS, PAYROLL_OPTIONS, type TaxTreatment } from '../../lib/taxTreatment';
import type { QueueLeg } from '../../hooks/useClassificationQueue';
import { fmtCurrency } from './util/format';

interface ClassifiedRowProps {
  targetId: number;
  kind: 'corp' | 'payroll';
  primary: QueueLeg;
  counter?: QueueLeg;
  onChanged: () => void;
}

export function ClassifiedRow({ targetId, kind, primary, counter, onChanged }: ClassifiedRowProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = kind === 'corp' ? CORP_OPTIONS : PAYROLL_OPTIONS;

  async function choose(next: TaxTreatment | null) {
    setError(null);
    setBusy(true);
    try {
      // Reuses the both-legs-correct endpoint: for a linked transfer pair this
      // atomically sets BOTH legs; `null` clears both. targetId is the personal
      // leg for corp pairs, the income txn for payroll.
      await patchJson(`/api/transfers/${targetId}/tax-treatment`, { taxTreatmentOverride: next });
      onChanged();
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
      <span className="w-24 text-right tabular-nums text-sm font-semibold">{fmtCurrency(primary.amount)}</span>
      <span className="flex-1 text-sm">
        <span>{flow}</span>
        {primary.merchantClean && <span> · {primary.merchantClean}</span>}
      </span>
      <TaxTreatmentSelect
        value={primary.taxTreatmentOverride}
        options={options}
        onChange={choose}
        emptyLabel="Clear (unclassify)"
        aria-label={`treatment for txn ${targetId}`}
      />
      {busy && <span className="muted text-xs">Saving…</span>}
      {error && <span className="error text-xs" role="alert">{error}</span>}
    </li>
  );
}
```

- [ ] **Step 4: Create ClassifiedTab**

Create `frontend/src/pages/tax/ClassifiedTab.tsx`:

```tsx
import { useTaxEntities } from '../../hooks/useTaxEntities';
import { useClassificationQueue } from '../../hooks/useClassificationQueue';
import { ClassifiedRow } from './ClassifiedRow';

export function ClassifiedTab({ year }: { year: number }) {
  const { entities, error: entitiesError } = useTaxEntities();
  const personalEntity = entities?.find((e) => e.kind === 'personal') ?? null;
  const { data, error, loading, reload } = useClassificationQueue(
    personalEntity?.id ?? null,
    year,
    'classified',
  );

  if (entitiesError) return <p className="error">Failed to load entities: {entitiesError}</p>;
  if (!personalEntity && entities !== null) return <p className="muted">No personal entity for this household.</p>;
  if (loading || data === null) return <p className="muted">Loading…</p>;
  if (error) return <p className="error">Failed to load classified income: {error}</p>;

  const corp = data.corpDistributions;
  const payroll = data.payroll;
  const nothing = corp.length === 0 && payroll.length === 0;

  return (
    <div>
      <h2>Classified income — {year}</h2>
      {nothing && <p className="muted">No classified income for {year}.</p>}

      {corp.length > 0 && (
        <section>
          <h3>Corp → personal · {corp.length}</h3>
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {corp.map((d) => (
              <ClassifiedRow
                key={d.personal.id}
                targetId={d.personal.id}
                kind="corp"
                primary={d.personal}
                counter={d.corp}
                onChanged={reload}
              />
            ))}
          </ul>
        </section>
      )}

      {payroll.length > 0 && (
        <section>
          <h3>Payroll · {payroll.length}</h3>
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {payroll.map((p) => (
              <ClassifiedRow key={p.id} targetId={p.id} kind="payroll" primary={p} onChanged={reload} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/pages/tax/ClassifiedTab.test.tsx`
Expected: PASS (all four cases).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/tax/ClassifiedRow.tsx frontend/src/pages/tax/ClassifiedTab.tsx frontend/src/pages/tax/ClassifiedTab.test.tsx
git commit --no-verify -m "feat(tax): ClassifiedTab + ClassifiedRow for reclassify/clear"
```

---

## Task 5: Frontend — register the "Classified" tab in TaxPage

**Files:**
- Modify: `frontend/src/pages/TaxPage.tsx`

- [ ] **Step 1: Add the import**

In `frontend/src/pages/TaxPage.tsx`, after the `ClassifyTab` import (line 13):

```tsx
import { ClassifiedTab } from './tax/ClassifiedTab'
```

- [ ] **Step 2: Add the tab to the TABS array**

In the `TABS` array, immediately after `{ value: 'classify', label: 'Classify' },`:

```tsx
  { value: 'classified', label: 'Classified' },
```

- [ ] **Step 3: Render the tab**

In the JSX render block, immediately after `{tab === 'classify' && <ClassifyTab year={year} />}`:

```tsx
          {tab === 'classified' && <ClassifiedTab year={year} />}
```

- [ ] **Step 4: Verify the frontend build/typecheck passes**

Run: `cd frontend && npx tsc -b`
Expected: exits 0, no type errors (this is the typecheck step of the build).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/TaxPage.tsx
git commit --no-verify -m "feat(tax): wire Classified tab into TaxPage"
```

---

## Task 6: Full verification — types, lint, targeted test suites

**Files:** none (verification only)

- [ ] **Step 1: Backend typecheck**

Run: `cd backend && yarn typecheck`
Expected: exits 0 (no `tsc --noEmit` errors).

- [ ] **Step 2: Backend tax tests**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/routes-classification-queue.test.ts test/tax/routes-tax-treatment.test.ts`
Expected: all PASS (queue classified/unclassified/invalid-status + the both-legs tax-treatment mutation tests).

- [ ] **Step 3: Frontend full test suite**

Run: `cd frontend && yarn test`
Expected: all PASS (includes the new hook + ClassifiedTab tests and the untouched ClassifyTab/TaxTreatmentSelect tests).

- [ ] **Step 4: Frontend + backend lint**

Run: `cd frontend && yarn lint && cd ../backend && yarn lint`
Expected: exits 0. Fix any lint errors introduced (e.g. unused imports), then re-run.

- [ ] **Step 5: Final commit (only if Step 4 required fixes)**

```bash
git add -A
git commit --no-verify -m "chore(tax): lint/type fixups for reclassification tab"
```

---

## Out of scope (do NOT build — flag as follow-up)

`ReviewInboxPage` and `TransactionsPage` set `taxTreatmentOverride` through the single-leg `/api/transactions` path; for a corp transfer leg edited there, the linked leg would not sync. Pre-existing and unverified. After the plan lands, surface this as a separate follow-up task — do not expand this PR's scope to fix it.

---

## Notes for the implementer

- **Why `/api/transfers/:id/tax-treatment` and not `/api/transactions/:id`:** the transfers endpoint (`backend/src/routes/transfers.ts:592`) wraps both legs in one `sequelize.transaction` and sets the linked sibling to the same value; `/api/transactions/:id` touches only one row and would desync a corp pair. Always use the transfers endpoint for treatment changes on classified items.
- **Commits use `--no-verify`** because the husky pre-commit hook invokes `lint-staged`, which is not installed in this fresh worktree. Lint is run explicitly in Task 6 instead.
- **Backend test runner:** `npx tsx --import ./test/setup.ts --test <files>` from `backend/` (mirrors the `test` script in `backend/package.json`). The tax tests use `sequelize.sync({ force: true })`, so no Postgres/migrations needed.
```
