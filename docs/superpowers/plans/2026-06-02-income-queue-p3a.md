# Income Queue P3a — Correctness + Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the corp-T2 double-count (classified txns authoritative), scope the classification queue per-member, batch its N+1, and DRY the treatment dropdowns onto a generalized `TaxTreatmentSelect`.

**Architecture:** Four independent changes — one backend builder edit, one backend route edit (two fixes in one handler), one shared frontend component generalization, one frontend refactor of 3 call sites. No new primitive.

**Tech Stack:** Backend TS/Express/Sequelize, `node:test` via `tsx`. Frontend React, vitest + @testing-library/react.

**Run tests:** backend `cd backend && npx tsx --import ./test/setup.ts --test test/tax/<f>.test.ts`; frontend `cd frontend && npx vitest run src/<path>`.

**Commit note:** worktree husky hook unresolvable → `git commit --no-verify`. Filter the pre-existing tsc deprecations: backend `grep -v moduleResolution`; frontend `grep -vE "baseUrl|moduleResolution|vite.config"`.

---

## File Structure
- **Modify** `backend/src/tax/builders/buildCorpFacts.ts` — remove manual-ledger distribution reads (Task 1).
- **Modify** `backend/src/routes/tax.ts` — queue: visibility scoping + N+1 batch (Task 2).
- **Modify** `frontend/src/components/TaxTreatmentSelect.tsx` + `frontend/src/pages/tax/ClassifyRow.tsx` — generalize (Task 3).
- **Modify** `frontend/src/pages/settings/tabs/CategoriesTab.tsx`, `frontend/src/pages/ReviewInboxPage.tsx`, `frontend/src/pages/TransactionsPage.tsx` — DRY (Task 4).
- **Tests:** `backend/test/tax/taxTreatment-corp.test.ts`, `backend/test/tax/routes-classification-queue.test.ts`, `frontend/src/components/TaxTreatmentSelect.test.tsx`.

---

### Task 1: Dedup — classified txns are the sole corp-T2 distribution source

**Files:** Modify `backend/src/tax/builders/buildCorpFacts.ts`; Test `backend/test/tax/taxTreatment-corp.test.ts`.

- [ ] **Step 1: Write the failing test** — append to `backend/test/tax/taxTreatment-corp.test.ts` (it already has `seedCorp()`):

```typescript
test('manual ShareholderLoan dividend_credit no longer feeds corp dividendsPaid', async () => {
  const s = await seedCorp();
  const models = await import('../../src/models/index.js');
  // a legacy manual dividend_credit row — must NOT count (classified txns are authoritative)
  await models.ShareholderLoan.create({ entityId: s.entity.id, date: '2025-03-01', kind: 'dividend_credit', amount: '9999.0000' } as never);
  const facts = await buildCorpFacts(s.entity.id, { startDate: '2025-01-01', endDate: '2025-12-31' });
  assert.equal(facts.dividendsPaid.length, 0, 'manual dividend_credit must not contribute');
  assert.equal(facts.salaryPaid.toFixed(2), '0.00');
});
```
(If `taxTreatment-corp.test.ts` imports `ShareholderLoan` differently, use the models-index dynamic import shown.)

- [ ] **Step 2: Run, verify FAIL** — `cd backend && npx tsx --import ./test/setup.ts --test test/tax/taxTreatment-corp.test.ts` (manual row currently produces 1 dividendsPaid entry).

- [ ] **Step 3: Remove the manual-ledger distribution reads.** In `buildCorpFacts.ts`, DELETE the `loanRows` fetch (the `// ShareholderLoan entries in fiscal year` comment + `const loanRows = await ShareholderLoan.findAll({...})`) AND the `for (const loan of loanRows) { ... }` loop. KEEP `const dividendsPaid: CorpDividendPaid[] = [];` and `let salaryPaid = D(0);`, and KEEP the `// Classified corp→personal distributions` loop that follows. The block should go from:

```typescript
  // ShareholderLoan entries in fiscal year
  const loanRows = await ShareholderLoan.findAll({ where: { entityId, date: { [Op.between]: [startDate, endDate] } }, order: [['date', 'ASC']] });

  const dividendsPaid: CorpDividendPaid[] = [];
  let salaryPaid = D(0);

  for (const loan of loanRows) {
    if (loan.kind === 'dividend_credit') { dividendsPaid.push({ ... }); }
    else if (loan.kind === 'salary_credit') { salaryPaid = salaryPaid.plus(D(loan.amount)); }
  }

  // Classified corp→personal distributions ...
  for (const t of txns) { ... }
```
to:
```typescript
  const dividendsPaid: CorpDividendPaid[] = [];
  let salaryPaid = D(0);

  // Classified corp→personal distributions are the sole source for corp T2
  // dividends/salary (the manual ShareholderLoan ledger is for non-transaction
  // adjustments only; double-counting it here was a latent bug). The corp leg
  // is an outflow (negative); distributions/remuneration are positive.
  for (const t of txns) { ... }   // unchanged
```

- [ ] **Step 4: Remove the now-unused `ShareholderLoan` import.** In `buildCorpFacts.ts`, remove `ShareholderLoan` from the `import { ... } from '../../models'` list (confirm it's referenced nowhere else in the file with `grep -n ShareholderLoan backend/src/tax/builders/buildCorpFacts.ts` → should be empty after the edit).

- [ ] **Step 5: Run, verify PASS** — the new test + the existing corp tests (classified dividend/salary still produce correct `dividendsPaid`/`salaryPaid`).

- [ ] **Step 6: Typecheck + commit** — `cd backend && npx tsc --noEmit 2>&1 | grep -v moduleResolution | grep "error TS"` (expect none).
```bash
git add backend/src/tax/builders/buildCorpFacts.ts backend/test/tax/taxTreatment-corp.test.ts
git commit --no-verify -m "fix(tax): classified txns are sole corp-T2 distribution source (dedup)"
```

---

### Task 2: Queue — per-member visibility scoping + batch the N+1

**Files:** Modify `backend/src/routes/tax.ts` (the `/classification-queue` handler, ~line 26); Test `backend/test/tax/routes-classification-queue.test.ts`.

- [ ] **Step 1: Write the failing test** — append to `backend/test/tax/routes-classification-queue.test.ts`:

```typescript
test('queue excludes another member private corp→personal pair', async () => {
  const models = await import('../../src/models/index.js');
  const ts = Date.now();
  // a private pair created by a DIFFERENT user in the same household — must be excluded
  const otherUser = await models.User.create({
    email: `cq-other-${ts}@example.com`, displayName: 'Other', globalRole: 'user',
    passwordHash: 'x', passwordSalt: 'x', passwordParams: '{}',
  } as never);
  const pPriv = await models.Transaction.create({
    accountId: personalAccountId, householdId, entityId: personalEntityId,
    date: '2025-09-01', amount: '4000', currency: 'CAD', txnType: 'transfer',
    visibility: 'private', createdByUserId: otherUser.id,
    merchantRaw: 'PRIV', merchantClean: 'PRIV', importBatch: 'b',
    sourceRowFingerprint: `fp-priv-${ts}`, sourceIdentityFingerprint: `sif-priv-${ts}`,
  } as never);
  const cPriv = await models.Transaction.create({
    accountId: corpAccountId, householdId, entityId: corpEntityId,
    date: '2025-09-01', amount: '-4000', currency: 'CAD', txnType: 'transfer',
    visibility: 'private', createdByUserId: otherUser.id, linkedTransactionId: pPriv.id,
    merchantRaw: 'PRIV', merchantClean: 'PRIV', importBatch: 'b',
    sourceRowFingerprint: `fp-privc-${ts}`, sourceIdentityFingerprint: `sif-privc-${ts}`,
  } as never);
  await pPriv.update({ linkedTransactionId: cPriv.id });

  const res = await authed.get(`/api/tax/classification-queue?entityId=${personalEntityId}&year=2025`);
  assert.equal(res.status, 200);
  const ids = res.body.corpDistributions.map((d: { personal: { id: number } }) => d.personal.id);
  assert.ok(!ids.includes(pPriv.id), 'another member private pair must be excluded');
});
```
(Reuse the file's existing `authed`/`personalEntityId`/`corpEntityId`/`personalAccountId`/`corpAccountId`/`householdId` from its `before`.)

- [ ] **Step 2: Run, verify FAIL** — the private pair currently appears (queue ignores visibility).

- [ ] **Step 3: Implement visibility scoping + batch.** In `backend/src/routes/tax.ts`: add `import { visibleTransactionWhere } from '../auth/scope';` near the other imports. In the `/classification-queue` handler, change the two queries + replace the N+1 loop:

```typescript
    const personalLegs = await Transaction.findAll({
      where: {
        ...visibleTransactionWhere(req),
        entityId,
        date: { [Op.between]: [start, end] },
        txnType: 'transfer',
        linkedTransactionId: { [Op.ne]: null },
        taxTreatmentOverride: null,
      },
    });

    // Batch-resolve the corp legs (no N+1 findByPk loop).
    const linkedIds = personalLegs
      .map((l) => l.linkedTransactionId)
      .filter((x): x is number => x != null);
    const linkedTxns = linkedIds.length
      ? await Transaction.findAll({ where: { id: { [Op.in]: linkedIds } } })
      : [];
    const linkedById = new Map(linkedTxns.map((t) => [t.id, t]));
    const corpDistributions: Array<{ personal: Transaction; corp: Transaction }> = [];
    for (const leg of personalLegs) {
      const other = linkedById.get(leg.linkedTransactionId as number);
      if (other && other.entityId != null && corpEntityIds.has(other.entityId)) {
        corpDistributions.push({ personal: leg, corp: other });
      }
    }

    const payroll = await Transaction.findAll({
      where: {
        ...visibleTransactionWhere(req),
        entityId,
        date: { [Op.between]: [start, end] },
        txnType: 'income',
        taxTreatmentOverride: null,
      },
    });
```
(The corp legs are fetched without the visibility scope — they belong to the corp entity, already gated by `corpEntityIds` membership in the same household. The personal-side scope is what enforces per-member privacy on what the user sees.)

- [ ] **Step 4: Run, verify PASS** — the new exclusion test + all existing queue tests (the shared pairs still resolve via the batch map; accountName assertions hold).

- [ ] **Step 5: Typecheck + commit** — `cd backend && npx tsc --noEmit 2>&1 | grep -v moduleResolution | grep "error TS"` (expect none).
```bash
git add backend/src/routes/tax.ts backend/test/tax/routes-classification-queue.test.ts
git commit --no-verify -m "fix(tax): scope classification-queue by visibility + batch the N+1"
```

---

### Task 3: Generalize `TaxTreatmentSelect` (selectable empty) + update `ClassifyRow`

**Files:** Modify `frontend/src/components/TaxTreatmentSelect.tsx` + `frontend/src/components/TaxTreatmentSelect.test.tsx` + `frontend/src/pages/tax/ClassifyRow.tsx`.

- [ ] **Step 1: Add failing tests** — append to `frontend/src/components/TaxTreatmentSelect.test.tsx`:

```tsx
it('with emptyLabel, the empty option is selectable and fires onChange(null)', () => {
  const onChange = vi.fn();
  render(
    <TaxTreatmentSelect value={'salary'} options={['salary']} emptyLabel="Keep current" onChange={onChange} aria-label="t" />,
  );
  const select = screen.getByLabelText('t') as HTMLSelectElement;
  const empty = select.querySelector('option[value=""]') as HTMLOptionElement;
  expect(empty.disabled).toBe(false);
  expect(empty.textContent).toBe('Keep current');
  fireEvent.change(select, { target: { value: '' } });
  expect(onChange).toHaveBeenCalledWith(null);
});

it('without emptyLabel, the placeholder option is disabled', () => {
  render(<TaxTreatmentSelect value={null} options={['salary']} onChange={vi.fn()} aria-label="t2" />);
  const empty = (screen.getByLabelText('t2') as HTMLSelectElement).querySelector('option[value=""]') as HTMLOptionElement;
  expect(empty.disabled).toBe(true);
});
```

- [ ] **Step 2: Run, verify FAIL** — `cd frontend && npx vitest run src/components/TaxTreatmentSelect.test.tsx` (emptyLabel prop not supported; empty always disabled).

- [ ] **Step 3: Generalize the component** — replace `frontend/src/components/TaxTreatmentSelect.tsx` with:

```tsx
import { TREATMENT_LABELS, type TaxTreatment } from '../lib/taxTreatment';

interface TaxTreatmentSelectProps {
  value: TaxTreatment | null;
  options: TaxTreatment[];
  onChange: (next: TaxTreatment | null) => void;
  /** When set, the empty option is selectable with this label and selecting it fires onChange(null). */
  emptyLabel?: string;
  /** Disabled placeholder text when emptyLabel is not provided. */
  placeholder?: string;
  'aria-label'?: string;
}

export function TaxTreatmentSelect({
  value,
  options,
  onChange,
  emptyLabel,
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
        onChange(next === '' ? null : (next as TaxTreatment));
      }}
    >
      <option value="" disabled={emptyLabel === undefined}>
        {emptyLabel ?? placeholder}
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

- [ ] **Step 4: Update `ClassifyRow`** — in `frontend/src/pages/tax/ClassifyRow.tsx`, change the handler to accept `null` (it runs in placeholder mode so `null` never actually fires, but the type must match):

```tsx
  async function choose(next: TaxTreatment | null) {
    if (!next) return;
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
```
(The `<TaxTreatmentSelect ... onChange={choose} />` usage is unchanged.)

- [ ] **Step 5: Run, verify PASS** — `cd frontend && npx vitest run src/components/TaxTreatmentSelect.test.tsx src/pages/tax/ClassifyTab.test.tsx` (the new cases + the existing component test + the ClassifyTab test all green).

- [ ] **Step 6: Typecheck + commit** — `cd frontend && npx tsc -b 2>&1 | grep "error TS" | grep -vE "baseUrl|moduleResolution|vite.config"` (expect empty).
```bash
git add frontend/src/components/TaxTreatmentSelect.tsx frontend/src/components/TaxTreatmentSelect.test.tsx frontend/src/pages/tax/ClassifyRow.tsx
git commit --no-verify -m "feat(tax): generalize TaxTreatmentSelect with selectable-empty mode"
```

---

### Task 4: DRY the 3 hand-rolled treatment selects

**Files:** Modify `frontend/src/pages/settings/tabs/CategoriesTab.tsx`, `frontend/src/pages/ReviewInboxPage.tsx`, `frontend/src/pages/TransactionsPage.tsx`.

- [ ] **Step 1: CategoriesTab.** In `frontend/src/pages/settings/tabs/CategoriesTab.tsx`, add `import { TaxTreatmentSelect } from '../../../components/TaxTreatmentSelect';`. Replace the `<select aria-label={\`Tax treatment for ${cat.name}\`} …>…</select>` block with:

```tsx
            <TaxTreatmentSelect
              aria-label={`Tax treatment for ${cat.name}`}
              value={cat.taxTreatment}
              options={[...TAX_TREATMENTS]}
              onChange={(t) => { if (t) void setTreatment(cat, t); }}
            />
```
(`TAX_TREATMENTS`/`TREATMENT_LABELS` imports may now be unused in this file — remove any that are.)

- [ ] **Step 2: ReviewInboxPage.** In `frontend/src/pages/ReviewInboxPage.tsx`, add the `TaxTreatmentSelect` import. Replace the treatment `<NativeSelect value={taxTreatment} …>…</NativeSelect>` block with:

```tsx
              <TaxTreatmentSelect
                value={taxTreatment || null}
                options={TAX_TREATMENTS.filter((tt) => tt !== 'none')}
                emptyLabel="Keep current"
                onChange={(t) => setTaxTreatment(t ?? '')}
              />
```
(Leave the surrounding `<Label>Tax treatment …</Label>`. Keep the `NativeSelect`/`NativeSelectOption` imports — they're used by other selects in the file. Remove `TREATMENT_LABELS` import only if now unused.)

- [ ] **Step 3: TransactionsPage.** In `frontend/src/pages/TransactionsPage.tsx`, add the `TaxTreatmentSelect` import. Replace the `<NativeSelect aria-label={\`Tax treatment override for transaction ${t.id}\`} value={taxOverride} …>…</NativeSelect>` block with:

```tsx
        <TaxTreatmentSelect
          aria-label={`Tax treatment override for transaction ${t.id}`}
          value={taxOverride || null}
          options={TAX_TREATMENTS.filter((tt) => tt !== 'none')}
          emptyLabel="Use category default"
          onChange={(t) => setTaxOverride(t ?? '')}
        />
```
(Keep `NativeSelect` imports — used by other selects. Remove `TREATMENT_LABELS` import only if now unused.)

- [ ] **Step 4: Typecheck** — `cd frontend && npx tsc -b 2>&1 | grep "error TS" | grep -vE "baseUrl|moduleResolution|vite.config"` (expect empty). Fix any unused-import errors the removals surfaced.

- [ ] **Step 5: Run affected tests.** Run any tests for these pages: `cd frontend && npx vitest run src/pages/ReviewInboxPage.test.tsx src/pages/TransactionsPage.test.tsx src/pages/settings/tabs/CategoriesTab.test.tsx 2>/dev/null` — for each that EXISTS, if it asserts on the old `NativeSelect`/`<select>` markup (e.g. queries options by role), update the assertion to the new `TaxTreatmentSelect` markup (a `<select>` with the same `aria-label`); the treatment values + onChange behavior are unchanged. If a file doesn't exist, skip it. Then run the full changed-area sweep `cd frontend && npx vitest run src/pages` and confirm no regressions in the touched files.

- [ ] **Step 6: Commit**
```bash
git add frontend/src/pages/settings/tabs/CategoriesTab.tsx frontend/src/pages/ReviewInboxPage.tsx frontend/src/pages/TransactionsPage.tsx
git commit --no-verify -m "refactor(tax): DRY the 3 treatment selects onto TaxTreatmentSelect"
```

---

## Self-Review

**Spec coverage:** Dedup → Task 1. Queue visibility + N+1 → Task 2. Generalize TaxTreatmentSelect + ClassifyRow → Task 3. DRY 3 sites → Task 4. All four spec items covered.

**Placeholder scan:** No TBD/TODO. Task 4 Step 5 says "if the test file exists / if it asserts on old markup" — these are real conditionals (the test files may not exist), each with a concrete action; the implementer greps and adapts. The `<select>…</select>` and `<NativeSelect>…</NativeSelect>` blocks to replace are quoted by their exact `aria-label`/`value` anchors.

**Type consistency:** `TaxTreatmentSelect.onChange` is `(TaxTreatment | null)` across Task 3 (component), `ClassifyRow.choose` (Task 3), and all three call sites (Task 4 — each handles `null` via `if (t)`/`t ?? ''`). `value` is `TaxTreatment | null` everywhere (`cat.taxTreatment` is non-null; `taxTreatment || null` / `taxOverride || null` coerce `''`→`null`). `visibleTransactionWhere(req)` spread matches its use in `transfers.ts`. Backend `dividendsPaid`/`salaryPaid` shapes unchanged in Task 1 (only the manual source removed).

**Ordering:** Task 4 depends on Task 3 (generalized component). Tasks 1, 2 are independent (backend). Execute 1→2→3→4.
