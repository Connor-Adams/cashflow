# Tax category treatment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `Category` declare a tax treatment (with a per-transaction override) that flows into the personal T1, so free-form categories can feed the engine's employment/donation/RRSP/FHSA branches.

**Architecture:** Add `Category.taxTreatment` (default) + `Transaction.taxTreatmentOverride` (nullable). `buildPersonalFacts` resolves `override ?? categoryDefault ?? 'none'` live (no stored `final*` column) and branches on the resolved treatment instead of matching hardcoded `finalCategory` strings. Self-employment stays the orthogonal `finalBusiness` flag.

**Tech Stack:** TypeScript, Sequelize (Postgres prod / SQLite tests via `sequelize.sync`), Express, sequelize-cli migrations, React + Vitest, `node:test` + `tsx` for backend.

**Spec:** `docs/superpowers/specs/2026-06-01-tax-category-treatment-design.md`

**Preconditions / environment:**
- This plan edits `buildPersonalFacts.ts` lines that PRs #494 and #496 also touch. **Rebase this branch on a `main` that includes #494 and #496 before implementing.** Task 3's "before" code below is the post-#496 version (`t.finalCategory` / `t.finalBusiness`, activity loop uses `D(a.amount ?? 0)`).
- Backend unit tests: `cd backend && npx tsx --import ./test/setup.ts --test <file>`. They use `sequelize.sync({ force: true })`, so **model field additions** (not migrations) are what make columns exist in tests.
- Integration tests (`backend/test/integration/*`): `cd backend && yarn test:integration` (needs a Postgres test DB via `setupPgTestDb`).
- Husky's `pre-commit` runs `lint-staged`, which is not installed in the worktree. Commit with `git commit --no-verify` (CI runs the real lint).

---

### Task 1: Shared tax-treatment vocabulary

**Files:**
- Modify: `shared/api-types.ts` (add vocabulary near the `CATEGORY_ICON_NAMES` block ~line 1100-1189; add `taxTreatment` to `Category` type ~line 455)

- [ ] **Step 1: Add the vocabulary + type guard**

Append to `shared/api-types.ts` (next to `isCategoryIconName`):

```ts
export const TAX_TREATMENTS = [
  'none',
  'employment_income',
  'donations',
  'rrsp_contribution',
  'fhsa_contribution',
] as const

export type TaxTreatment = (typeof TAX_TREATMENTS)[number]

export function isTaxTreatment(value: unknown): value is TaxTreatment {
  return (
    typeof value === 'string' &&
    (TAX_TREATMENTS as readonly string[]).includes(value)
  )
}
```

- [ ] **Step 2: Add `taxTreatment` to the shared `Category` type**

In `shared/api-types.ts` ~line 455:

```ts
export type Category = {
  id: number
  householdId: number
  name: string
  icon: string | null
  taxTreatment: TaxTreatment
  createdAt: string
  updatedAt: string
}
```

- [ ] **Step 3: Typecheck shared consumers**

Run: `cd backend && npx tsc --noEmit` and `cd frontend && npx tsc --noEmit`
Expected: no NEW errors (the pre-existing `tsconfig moduleResolution=node10` deprecation in backend is allowed). The `Category` type is now stricter; downstream `taxTreatment` usages get added in later tasks.

- [ ] **Step 4: Commit**

```bash
git add shared/api-types.ts
git commit --no-verify -m "feat(shared): add TaxTreatment vocabulary + Category.taxTreatment type"
```

(No standalone test: `isTaxTreatment` is a const+guard mirroring `isCategoryIconName`; it is exercised by the route tests in Tasks 4-5.)

---

### Task 2: Model fields + migration

**Files:**
- Modify: `backend/src/models/Category.ts` (class field + init)
- Modify: `backend/src/models/Transaction.ts` (class field + init, near `finalCategory` ~line 50/198)
- Create: `backend/src/migrations/20260615000001-add-tax-treatment-columns.js`
- Test: `backend/test/tax/taxTreatmentModel.test.ts`

> Migration filename must sort AFTER the latest existing migration (`20260614000002-*`). `20260615000001` does.

- [ ] **Step 1: Write the failing test**

Create `backend/test/tax/taxTreatmentModel.test.ts`:

```ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../src/db';
import { Category, Household } from '../../src/models';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

test('Category.taxTreatment defaults to "none" and is settable', async () => {
  const hh = await Household.create({ name: 'TT' });
  const a = await Category.create({ householdId: hh.id, name: 'Groceries' } as never);
  assert.equal(a.taxTreatment, 'none', 'defaults to none');

  const b = await Category.create({
    householdId: hh.id, name: 'Charity', taxTreatment: 'donations',
  } as never);
  assert.equal(b.taxTreatment, 'donations');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/taxTreatmentModel.test.ts`
Expected: FAIL — `taxTreatment` is `undefined` (column not on the model yet).

- [ ] **Step 3: Add the Category model field**

In `backend/src/models/Category.ts`, add the class field (after `icon`):

```ts
  declare taxTreatment: CreationOptional<string>;
```

Add `CreationOptional` to the sequelize import if not present. In `Category.init({...})` (after `icon`):

```ts
      taxTreatment: {
        type: DataTypes.STRING(32),
        field: 'tax_treatment',
        allowNull: false,
        defaultValue: 'none',
      },
```

(`underscored: true` is already set, but the explicit `field` keeps it unambiguous.)

- [ ] **Step 4: Add the Transaction model field**

In `backend/src/models/Transaction.ts`, add the class field (near `finalCategory` ~line 50):

```ts
  declare taxTreatmentOverride: string | null;
```

In `Transaction.init({...})` (near the `finalCategory` column ~line 198):

```ts
      taxTreatmentOverride: {
        type: DataTypes.STRING(32),
        field: 'tax_treatment_override',
        allowNull: true,
      },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/taxTreatmentModel.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the production migration**

Create `backend/src/migrations/20260615000001-add-tax-treatment-columns.js`:

```js
'use strict';
/** Category-driven tax treatment: a per-category default + a per-transaction
 * override consumed by buildPersonalFacts. See
 * docs/superpowers/specs/2026-06-01-tax-category-treatment-design.md */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('categories', 'tax_treatment', {
      type: Sequelize.STRING(32), allowNull: false, defaultValue: 'none',
    });
    await queryInterface.addColumn('transactions', 'tax_treatment_override', {
      type: Sequelize.STRING(32), allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('transactions', 'tax_treatment_override');
    await queryInterface.removeColumn('categories', 'tax_treatment');
  },
};
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/models/Category.ts backend/src/models/Transaction.ts \
  backend/src/migrations/20260615000001-add-tax-treatment-columns.js \
  backend/test/tax/taxTreatmentModel.test.ts
git commit --no-verify -m "feat(tax): add Category.taxTreatment + Transaction.taxTreatmentOverride columns"
```

---

### Task 3: Live resolution in buildPersonalFacts

**Files:**
- Modify: `backend/src/tax/builders/buildPersonalFacts.ts` (import `Category`; load map; branch on resolved treatment)
- Test: `backend/test/tax/buildPersonalFacts.test.ts` (append)

**Current code (post-#496) in the transaction loop:**

```ts
const cat = t.finalCategory ?? '';
if (cat === 'employment_income') employmentIncome.push(item);
else if (cat === 'donations') donations.push(item);
else if (cat === 'rrsp_contribution') {
  rrspContribs.push({ source: item.source, amount: cad.abs(), date: t.date as unknown as string });
}
else if (cat === 'fhsa_contribution') {
  fhsaContribs.push({ source: item.source, amount: cad.abs(), date: t.date as unknown as string });
}
else if (t.finalBusiness && cad.greaterThan(0)) selfEmploymentIncome.push(item);
else if (t.finalBusiness && cad.lessThan(0))
  selfEmploymentExpenses.push({ ...item, cadAmount: cad.abs(), amount: D(t.amount ?? 0).abs() });
```

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/tax/buildPersonalFacts.test.ts`:

```ts
test('category taxTreatment routes a transaction into employment income', async () => {
  const household = await Household.create({ name: 'TT employment' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P', jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Chk', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  await Category.create({
    householdId: household.id, name: 'Salary', taxTreatment: 'employment_income',
  } as never);
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2025-02-01', amount: '60000.0000', currency: 'CAD', finalCategory: 'Salary',
    merchantRaw: 'EMP', merchantClean: 'EMP', importBatch: 's',
    sourceRowFingerprint: 'fp-tt-emp-1', sourceIdentityFingerprint: 'sif-tt-emp-1',
  } as never);

  const facts = await buildPersonalFacts(entity.id, 2025);
  assert.equal(facts.employmentIncome.length, 1, 'category treatment feeds employment income');
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '60000.00');
});

test('transaction taxTreatmentOverride wins over the category default', async () => {
  const household = await Household.create({ name: 'TT override' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P', jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Chk', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  // Category default is 'none'; the override forces a donation.
  await Category.create({ householdId: household.id, name: 'Misc' } as never);
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2025-03-01', amount: '500.0000', currency: 'CAD', finalCategory: 'Misc',
    taxTreatmentOverride: 'donations',
    merchantRaw: 'CH', merchantClean: 'CH', importBatch: 's',
    sourceRowFingerprint: 'fp-tt-ovr-1', sourceIdentityFingerprint: 'sif-tt-ovr-1',
  } as never);

  const facts = await buildPersonalFacts(entity.id, 2025);
  assert.equal(facts.donations.length, 1, 'override beats category default');
  assert.equal(facts.donations[0].cadAmount.toFixed(2), '500.00');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/buildPersonalFacts.test.ts`
Expected: FAIL — both new tests: `employmentIncome` / `donations` length 0 (engine still matches raw `finalCategory`, which is `'Salary'`/`'Misc'`, not the constants).

- [ ] **Step 3: Implement live resolution**

In `backend/src/tax/builders/buildPersonalFacts.ts`:

3a. Add `Category` to the models import:

```ts
import {
  Account,
  Carryforward,
  Category,
  Entity,
  HouseholdMember,
  InvestmentActivity,
  InstalmentPayment,
  Security,
  TaxSlip,
  Transaction,
  User,
} from '../../models';
```

3b. After the `entity` is loaded and validated (just before the transaction loop), build the map:

```ts
  const householdCategories = await Category.findAll({ where: { householdId: entity.householdId } });
  const catTreatment = new Map(householdCategories.map((c) => [c.name, c.taxTreatment]));
```

3c. Replace the `const cat = ...` line and the four `cat === '<const>'` branches with resolved-treatment branches (leave the two `finalBusiness` branches unchanged):

```ts
    const treatment = t.taxTreatmentOverride ?? catTreatment.get(t.finalCategory ?? '') ?? 'none';
    if (treatment === 'employment_income') employmentIncome.push(item);
    else if (treatment === 'donations') donations.push(item);
    else if (treatment === 'rrsp_contribution') {
      rrspContribs.push({ source: item.source, amount: cad.abs(), date: t.date as unknown as string });
    }
    else if (treatment === 'fhsa_contribution') {
      fhsaContribs.push({ source: item.source, amount: cad.abs(), date: t.date as unknown as string });
    }
    else if (t.finalBusiness && cad.greaterThan(0)) selfEmploymentIncome.push(item);
    else if (t.finalBusiness && cad.lessThan(0))
      selfEmploymentExpenses.push({ ...item, cadAmount: cad.abs(), amount: D(t.amount ?? 0).abs() });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/buildPersonalFacts.test.ts`
Expected: PASS (all tests, including the pre-existing ones).

- [ ] **Step 5: Add the `Category` import to the test file if missing**

`buildPersonalFacts.test.ts` must import `Category` from `../../src/models` (add to the existing import). Re-run Step 4 if you adjusted imports.

- [ ] **Step 6: Commit**

```bash
git add backend/src/tax/builders/buildPersonalFacts.ts backend/test/tax/buildPersonalFacts.test.ts
git commit --no-verify -m "feat(tax): resolve category taxTreatment (+ per-txn override) in buildPersonalFacts"
```

---

### Task 4: categories route — accept `taxTreatment`

**Files:**
- Modify: `backend/src/routes/categories.ts`
- Test: `backend/test/integration/categories.test.ts` (append, follow existing supertest pattern)

- [ ] **Step 1: Write the failing test**

Append a test to `backend/test/integration/categories.test.ts` mirroring the file's existing PATCH tests (use `primaryAgent` and a known category id from the seeded household):

```ts
test('PATCH /api/categories/:id sets taxTreatment and rejects invalid', async () => {
  const list = await primaryAgent.get('/api/categories').expect(200);
  const cat = list.body[0];

  const ok = await primaryAgent
    .patch(`/api/categories/${cat.id}`)
    .send({ taxTreatment: 'donations' })
    .expect(200);
  assert.equal(ok.body.taxTreatment, 'donations');

  await primaryAgent
    .patch(`/api/categories/${cat.id}`)
    .send({ taxTreatment: 'not_a_treatment' })
    .expect(400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn test:integration` (filter to the categories file if supported)
Expected: FAIL — the route currently requires `icon` and ignores `taxTreatment` (the `taxTreatment`-only patch returns 400 "icon field required").

- [ ] **Step 3: Implement**

Replace the `PATCH /:id` handler body in `backend/src/routes/categories.ts` with one that handles `icon` and/or `taxTreatment` (at least one required), validating `taxTreatment` via `isTaxTreatment`:

```ts
import { isCategoryIconName, isTaxTreatment } from '@cashflow/shared';

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await Category.findOne({ where: { id, ...householdWhere(req) } });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const b = (req.body || {}) as Record<string, unknown>;
    const hasIcon = 'icon' in b;
    const hasTreatment = 'taxTreatment' in b;
    if (!hasIcon && !hasTreatment) {
      res.status(400).json({ error: 'icon or taxTreatment required' });
      return;
    }
    if (hasIcon) {
      if (b.icon === null) {
        row.set('icon', null);
      } else if (typeof b.icon === 'string' && isCategoryIconName(b.icon)) {
        row.set('icon', b.icon);
      } else {
        res.status(400).json({ error: 'unknown icon name' });
        return;
      }
    }
    if (hasTreatment) {
      if (!isTaxTreatment(b.taxTreatment)) {
        res.status(400).json({ error: 'unknown tax treatment' });
        return;
      }
      row.set('taxTreatment', b.taxTreatment);
    }
    await row.save();
    res.json(row);
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn test:integration`
Expected: PASS (new test + existing categories tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/categories.ts backend/test/integration/categories.test.ts
git commit --no-verify -m "feat(tax): PATCH /categories accepts taxTreatment"
```

---

### Task 5: transactions route — accept `taxTreatmentOverride`

**Files:**
- Modify: `backend/src/routes/transactions.ts` (`PATCHABLE_KEYS` ~line 353; validation in the `PATCH /:id` handler ~line 1091)
- Test: `backend/test/integration/` — add to the transactions integration test (find the file that exercises `PATCH /api/transactions/:id` with `categoryOverride`; follow its pattern)

- [ ] **Step 1: Write the failing test**

In the transactions integration test, add (mirroring an existing PATCH test that sets `categoryOverride`). Obtain a `txnId` for `primaryAgent`'s household by reusing the file's existing transaction seed helper, or create one inline via `const models = await import('../../src/models')` (Account + Transaction for `primaryHouseholdId`) exactly as the file's setup does:

```ts
test('PATCH /api/transactions/:id sets and clears taxTreatmentOverride', async () => {
  const txnId = await seedTransactionForPrimary(); // reuse the file's seed helper / inline model create
  const set = await primaryAgent
    .patch(`/api/transactions/${txnId}`)
    .send({ taxTreatmentOverride: 'rrsp_contribution' })
    .expect(200);
  assert.equal(set.body.taxTreatmentOverride, 'rrsp_contribution');

  await primaryAgent
    .patch(`/api/transactions/${txnId}`)
    .send({ taxTreatmentOverride: 'bogus' })
    .expect(400);

  const clear = await primaryAgent
    .patch(`/api/transactions/${txnId}`)
    .send({ taxTreatmentOverride: null })
    .expect(200);
  assert.equal(clear.body.taxTreatmentOverride, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn test:integration`
Expected: FAIL — `taxTreatmentOverride` is not in `PATCHABLE_KEYS`, so it is ignored (the field stays `null`/unchanged); the invalid case is not rejected.

- [ ] **Step 3: Implement**

3a. Add to `PATCHABLE_KEYS` (~line 353):

```ts
  'taxTreatmentOverride',
```

3b. Add a validation guard near the top of the `PATCH /:id` handler (after `const b = ...`, before `applyPatchBody`), importing `isTaxTreatment` from `@cashflow/shared`:

```ts
    if (
      'taxTreatmentOverride' in b &&
      b.taxTreatmentOverride !== null &&
      !isTaxTreatment(b.taxTreatmentOverride)
    ) {
      res.status(400).json({ error: 'unknown tax treatment' });
      return;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn test:integration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/transactions.ts backend/test/integration/<transactions test file>
git commit --no-verify -m "feat(tax): PATCH /transactions accepts taxTreatmentOverride"
```

---

### Task 6: CategoriesTab — per-category treatment dropdown

**Files:**
- Modify: `frontend/src/pages/settings/tabs/CategoriesTab.tsx`
- Test: `frontend/src/pages/settings/tabs/CategoriesTab.test.tsx` (follow existing pattern)

- [ ] **Step 1: Write the failing test**

Add to `CategoriesTab.test.tsx` (mirror the existing icon test; mock `patchJson`):

```tsx
test('changing tax treatment patches the category', async () => {
  // render CategoriesTab with a mocked useCategories returning one category
  // (taxTreatment: 'none'); select 'Donation' in its treatment dropdown.
  // Assert patchJson was called with /api/categories/<id> and { taxTreatment: 'donations' }.
});
```

(Fill in using the file's existing render/mocks for `useCategories` and `patchJson`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/settings/tabs/CategoriesTab.test.tsx`
Expected: FAIL — no treatment dropdown exists.

- [ ] **Step 3: Implement**

Add a `setTreatment` handler and a `<select>` per row. In `CategoriesTab.tsx`:

```tsx
import { TAX_TREATMENTS, type TaxTreatment } from '@cashflow/shared'

const TREATMENT_LABELS: Record<TaxTreatment, string> = {
  none: 'Default (none)',
  employment_income: 'Employment income',
  donations: 'Donation',
  rrsp_contribution: 'RRSP contribution',
  fhsa_contribution: 'FHSA contribution',
}

async function setTreatment(cat: Category, next: TaxTreatment) {
  setErr(null)
  try {
    await patchJson<Category>(`/api/categories/${cat.id}`, { taxTreatment: next })
    await refresh()
  } catch (e) {
    setErr(e instanceof Error ? e.message : 'Could not update tax treatment')
  }
}
```

In the `<li>` row (after the name span, before the "Change" icon button):

```tsx
            <select
              aria-label={`Tax treatment for ${cat.name}`}
              value={cat.taxTreatment}
              onChange={(e) => void setTreatment(cat, e.target.value as TaxTreatment)}
              className="text-sm"
            >
              {TAX_TREATMENTS.map((t) => (
                <option key={t} value={t}>{TREATMENT_LABELS[t]}</option>
              ))}
            </select>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/pages/settings/tabs/CategoriesTab.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/settings/tabs/CategoriesTab.tsx frontend/src/pages/settings/tabs/CategoriesTab.test.tsx
git commit --no-verify -m "feat(tax): per-category tax treatment selector in settings"
```

---

### Task 7: Per-transaction override control

**Files:**
- Modify: the transaction edit surface that renders the `businessOverride` toggle. Primary surface: `frontend/src/pages/TransactionsPage.tsx` (also referenced by `ReviewInboxPage.tsx`, `ItemDetailDrawer.tsx`). Implement in the shared edit control these use; if each has its own, do TransactionsPage first and the others follow the identical pattern.
- Test: the corresponding `*.test.tsx` for the chosen component.

- [ ] **Step 1: Locate the businessOverride control**

Run: `cd frontend && grep -rn "businessOverride" src/pages/TransactionsPage.tsx src/components`
Read the JSX + handler that sets `businessOverride` via `patchJson('/api/transactions/:id', { businessOverride })`. The treatment control mirrors it exactly.

- [ ] **Step 2: Write the failing test**

In the chosen component's test, add (mirroring its existing `businessOverride` test):

```tsx
test('changing tax treatment override patches the transaction', async () => {
  // render the edit control for a transaction (taxTreatmentOverride: null);
  // select 'RRSP contribution'; assert patchJson called with
  // /api/transactions/<id> and { taxTreatmentOverride: 'rrsp_contribution' }.
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run <component test path>`
Expected: FAIL — no treatment override control.

- [ ] **Step 4: Implement**

Add a `<select>` next to the business toggle, reusing the `TAX_TREATMENTS` / `TREATMENT_LABELS` (extract `TREATMENT_LABELS` to a shared frontend module, e.g. `frontend/src/lib/taxTreatment.ts`, and import it in both CategoriesTab and here — DRY). Options: a `Use category default` entry mapping to `null`, plus the four non-`none` treatments. Handler:

```tsx
async function setTaxOverride(txnId: number, next: TaxTreatment | null) {
  await patchJson(`/api/transactions/${txnId}`, { taxTreatmentOverride: next })
  // then refresh/refetch per the component's existing pattern
}
```

The select's `null` option sends `taxTreatmentOverride: null` (clear); a treatment sends that string.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run <component test path>`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/taxTreatment.ts frontend/src/pages/TransactionsPage.tsx <test file>
git commit --no-verify -m "feat(tax): per-transaction tax treatment override control"
```

---

### Task 8: Full verification

- [ ] **Step 1: Backend tax + integration suites**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/*.test.ts` then `yarn test:integration`
Expected: PASS (route failures from missing `sequelize-cli` are environment-only; ensure deps installed before relying on integration results).

- [ ] **Step 2: Typecheck both packages**

Run: `cd backend && npx tsc --noEmit` and `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Frontend unit tests**

Run: `cd frontend && npx vitest run src/pages/settings/tabs/CategoriesTab.test.tsx <txn component test>`
Expected: PASS.

- [ ] **Step 4: Manual prod-data sanity (optional)**

With `DATABASE_URL` set to the prod public proxy, run a one-off `tsx -e` that tags a real category (e.g. the one holding employment income) with `taxTreatment='employment_income'` in a scratch/throwaway copy, then `buildPersonalFacts(1, 2025)` and confirm `employmentIncome` is now populated. Do NOT mutate prod; read-only verification only.

- [ ] **Step 5: Open PR**

Push and open a PR against `main`; enable auto-merge (`gh pr merge --auto --merge --delete-branch`).
