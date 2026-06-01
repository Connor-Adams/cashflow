# Counterparty PR A — Manual per-transaction Contact picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user set/clear a transaction's canonical counterparty Contact (`counterpartyContactId`) from the transactions table, mirroring the existing `ownershipContactId` picker pattern.

**Architecture:** The DB column (`transactions.counterparty_contact_id`) and the model field already exist; the promote endpoints already write it. This PR only opens the **manual write path**: add `counterpartyContactId` to the transaction PATCH allow-list with household-scoped FK validation (mirroring `ownershipContactId`), and add a native-select picker to each transaction row that flows through the existing `onSave → patchJson → load()` save path. Direction ("to/from") already renders from the amount sign in the existing counterparty badge — no new field, no migration.

**Tech Stack:** Express + Sequelize (backend), `node:test` + supertest (backend tests), React + `@/components/ui/native-select` (frontend), vitest + @testing-library/react (frontend tests).

**Spine note:** Counterparty primitive. No new table, no new status machine. Not a spine change.

---

## File Structure

- Modify: `backend/src/routes/transactions.ts` — add `counterpartyContactId` to `PATCHABLE_KEYS` (line 345) and a validation branch in `applyPatchBody` (after line 413).
- Modify: `backend/test/integration/transactions.test.ts` — new PATCH cases mirroring the `ownershipContactId` cases at lines 481–537.
- Modify: `frontend/src/pages/TransactionsPage.tsx` — picker state + `NativeSelect` in `TransactionRow`, include field in the Save patch + `isDirty`.
- Create: `frontend/src/pages/TransactionsPage.counterparty.test.tsx` — focused render test for the picker → `onSave` wiring.

No new files in the backend; no migration.

---

## Task 1: Backend — make `counterpartyContactId` patchable with household-scoped validation

**Files:**
- Modify: `backend/src/routes/transactions.ts:345` (PATCHABLE_KEYS) and `:399-413` (applyPatchBody branch)
- Test: `backend/test/integration/transactions.test.ts`

The existing `ownershipContactId` branch (`applyPatchBody`, lines 399–413) is the exact pattern to mirror, except `counterpartyContactId` has **no** coupling to `ownershipType` (it is independent — never force-nulled, never required).

- [ ] **Step 1: Write the failing tests**

Add these three tests to `backend/test/integration/transactions.test.ts` (place them next to the existing `ownershipContactId` tests, after the block ending at line ~537). They reuse the file's existing helpers (`createTxn`, `agentA`, `contactAId`, `contactBId`):

```ts
test('PATCH /:id: counterpartyContactId links a household contact', async () => {
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-01-05',
    amount: -50,
  });
  const res = await agentA.patch(`/api/transactions/${id}`).send({
    counterpartyContactId: contactAId,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.counterpartyContactId, contactAId);
});

test('PATCH /:id: counterpartyContactId=null clears the link', async () => {
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-01-05',
    amount: -50,
  });
  await agentA.patch(`/api/transactions/${id}`).send({ counterpartyContactId: contactAId });
  const res = await agentA.patch(`/api/transactions/${id}`).send({ counterpartyContactId: null });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.counterpartyContactId, null);
});

test('PATCH /:id: cross-household counterpartyContactId throws 400', async () => {
  const id = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-01-05',
    amount: -50,
  });
  const res = await agentA.patch(`/api/transactions/${id}`).send({
    counterpartyContactId: contactBId,
  });
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd backend && yarn test:integration --test-name-pattern="counterpartyContactId"`
(If that flag is unsupported in this repo's runner, run the whole file: `yarn test:integration test/integration/transactions.test.ts`.)
Expected: the link test FAILS (`counterpartyContactId` is ignored, so body stays `null`); the cross-household test FAILS (returns 200, not 400).

- [ ] **Step 3: Add the field to the allow-list**

In `backend/src/routes/transactions.ts`, add `'counterpartyContactId'` to `PATCHABLE_KEYS` (line 345–356):

```ts
const PATCHABLE_KEYS = [
  'categoryOverride',
  'businessOverride',
  'splitOverride',
  'pctMeOverride',
  'pctPartnerOverride',
  'notes',
  'visibility',
  'ownershipType',
  'ownershipContactId',
  'counterpartyContactId',
  'status',
] as const;
```

- [ ] **Step 4: Add the validation branch**

In `applyPatchBody`, add a branch after the `ownershipContactId` branch (i.e. after line 413, before the `else if (k === 'status')` branch). It mirrors `ownershipContactId` but with no ownership coupling:

```ts
      } else if (k === 'counterpartyContactId') {
        if (b[k] == null || b[k] === '') {
          txn.set('counterpartyContactId', null);
        } else {
          const contactId = Number(b[k]);
          const contact = await Contact.findOne({
            where: { id: contactId, householdId: household.id },
          });
          if (!contact) {
            const err = new Error(
              'counterpartyContactId must reference a household contact',
            ) as Error & { status?: number };
            err.status = 400;
            throw err;
          }
          txn.set('counterpartyContactId', contact.id);
        }
```

Do **not** add any `ownershipType`-style coupling for this field — it is set independently of ownership.

- [ ] **Step 5: Run the tests, verify they pass**

Run: `cd backend && yarn test:integration test/integration/transactions.test.ts`
Expected: all three new tests PASS, and the pre-existing tests in the file still PASS. The link test passing also confirms `serializeTransaction` already returns `counterpartyContactId` (the badge reads it from GET); if the link test still shows `undefined`, add `counterpartyContactId: txn.counterpartyContactId` to `serializeTransaction` and re-run.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/transactions.ts backend/test/integration/transactions.test.ts
git commit -m "feat(counterparty): allow setting counterpartyContactId via transaction PATCH"
```

---

## Task 2: Frontend — counterparty picker in the transaction row

**Files:**
- Modify: `frontend/src/pages/TransactionsPage.tsx` (the `TransactionRow` component: state ~1970, merchant cell ~2072, `isDirty`, Save patch ~2365)
- Test: `frontend/src/pages/TransactionsPage.counterparty.test.tsx` (create)

The picker mirrors the existing `ownershipContactId` `NativeSelect` (lines 2179–2192): pick from the in-memory `contacts` prop, no inline create (consistent with the ownership picker; new contacts are created in Settings → Contacts, and PR B auto-creates them on import).

- [ ] **Step 1: Export `TransactionRow` for testing (if not already exported)**

In `frontend/src/pages/TransactionsPage.tsx`, find the `TransactionRow` component declaration (the row component that receives `t`, `onSave`, `onError`, `contacts`, with the `onSave` prop typed at ~line 1938). If it is declared `function TransactionRow(...)` without `export`, change it to `export function TransactionRow(...)`. Leave the default page export untouched.

- [ ] **Step 2: Write the failing test**

Create `frontend/src/pages/TransactionsPage.counterparty.test.tsx`. Build the fixture transaction from the row's transaction type (import `Transaction` from `../types/api`); fill required fields with neutral values. The assertion targets only the new wiring: selecting a contact then clicking Save calls `onSave` with `counterpartyContactId` set.

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TransactionRow } from './TransactionsPage';
import type { Transaction } from '../types/api';

// Minimal valid row fixture. Extend with any additional REQUIRED fields the
// TransactionRow prop type demands (follow the type errors from `tsc`).
const txn = {
  id: 1,
  date: '2026-01-05',
  amount: '-50.0000',
  currency: 'CAD',
  merchantClean: 'Interac e-Transfer',
  merchantRaw: 'INTERAC E-TRANSFER TO JOHN',
  finalCategory: null,
  status: 'posted',
  visibility: 'shared',
  ownershipType: 'me',
  ownershipContactId: null,
  counterpartyContactId: null,
  counterpartyRaw: 'JOHN',
  reviewFlag: false,
} as unknown as Transaction;

const contacts = [
  { id: 7, householdId: 1, name: 'John', notes: null, isPartner: false },
  { id: 8, householdId: 1, name: 'Mom', notes: null, isPartner: false },
];

function renderRow(onSave = vi.fn().mockResolvedValue(undefined)) {
  render(
    <table><tbody>
      <TransactionRow
        t={txn}
        contacts={contacts as never}
        onSave={onSave}
        onError={vi.fn()}
      />
    </tbody></table>,
  );
  return onSave;
}

describe('TransactionRow counterparty picker', () => {
  it('saves the selected counterparty contact', async () => {
    const onSave = renderRow();
    const select = screen.getByLabelText(/counterparty for transaction 1/i);
    fireEvent.change(select, { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ counterpartyContactId: 7 }),
    );
  });
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `cd frontend && yarn vitest run src/pages/TransactionsPage.counterparty.test.tsx`
Expected: FAIL — `getByLabelText(/counterparty for transaction 1/i)` throws (the select does not exist yet). If instead it fails on missing required props, add those props to the `txn` fixture until the render succeeds and the failure is specifically the missing select.

- [ ] **Step 4: Add picker state**

In `TransactionRow`, next to the ownership state (lines ~1970–1975), add:

```tsx
  const [counterpartyContactId, setCounterpartyContactId] = useState(
    t.counterpartyContactId != null ? String(t.counterpartyContactId) : ''
  )
```

- [ ] **Step 5: Render the picker in the merchant cell**

In the merchant `<TableCell>`, immediately after the read-only counterparty badge block (currently lines 2072–2083, ending `)}`), add an always-rendered select:

```tsx
          <NativeSelect
            value={counterpartyContactId}
            onChange={(e) => setCounterpartyContactId(e.target.value)}
            aria-label={`Counterparty for transaction ${t.id}`}
            className="mt-1 text-xs"
          >
            <NativeSelectOption value="">No counterparty</NativeSelectOption>
            {contacts.map((contact) => (
              <NativeSelectOption key={contact.id} value={contact.id}>
                {contact.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
```

(`NativeSelect`/`NativeSelectOption` are already imported at the top of the file.)

- [ ] **Step 6: Include the field in `isDirty` and the Save patch**

Find the `const isDirty =` expression in `TransactionRow` (it ORs per-field comparisons of edit-state vs original `t.*`). Add this term so the Save button enables when the counterparty changes:

```tsx
    || (t.counterpartyContactId ?? null) !==
       (counterpartyContactId === '' ? null : Number(counterpartyContactId))
```

Then in the Save button's `onSave` patch object (lines ~2365–2377), add the field:

```tsx
                counterpartyContactId:
                  counterpartyContactId === '' ? null : Number(counterpartyContactId),
```

- [ ] **Step 7: Run the test + typecheck**

Run: `cd frontend && yarn vitest run src/pages/TransactionsPage.counterparty.test.tsx`
Expected: PASS.
Run: `cd frontend && yarn tsc --noEmit` (or the repo's `yarn typecheck` script if present)
Expected: no type errors.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/TransactionsPage.tsx frontend/src/pages/TransactionsPage.counterparty.test.tsx
git commit -m "feat(counterparty): add per-row counterparty contact picker to transactions table"
```

---

## Task 3: Verify in the app + open PR

- [ ] **Step 1: Smoke test the real app**

Use the `/run` skill (or the repo's dev command) to launch the app. On the transactions page: pick a contact in a row's new "Counterparty" select, click Save, confirm the row's "to/from <name>" badge updates and the value survives a reload (it persisted via PATCH). Pick "No counterparty", Save, confirm it clears.

- [ ] **Step 2: Full test gate**

Run: `cd backend && yarn test:integration test/integration/transactions.test.ts`
Run: `cd frontend && yarn vitest run src/pages/TransactionsPage.counterparty.test.tsx && yarn tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 3: Push + PR with auto-merge (merge commit, no squash)**

```bash
git push -u origin HEAD
gh pr create --title "feat(counterparty): manual per-transaction Contact picker (PR A)" \
  --body "Opens the manual write path for the canonical counterparty link (counterpartyContactId) on transactions: household-scoped PATCH validation + a per-row native-select picker mirroring the ownership picker. No migration. Spec: docs/superpowers/specs/2026-05-31-canonical-counterparty-on-transactions-design.md" \
  --base main
gh pr merge --auto --merge
```

(Per repo policy: auto-merge with a merge commit, never squash. Enable `allow_auto_merge` first if the API rejects `--auto`.)

---

## Self-review (completed during planning)

- **Spec coverage:** Implements spec §"PR A — Manual per-transaction picker" in full (PATCHABLE_KEYS + validation + picker + direction-from-sign). PR B (import auto-link) and PR C (backfill) are separate plans.
- **Deviation from spec — flagged:** The spec mentioned "Create '<name>' inline". This plan uses pick-existing-only (a `NativeSelect`), matching the existing `ownershipContactId` picker, because no inline-create combobox exists on this page and PR B will auto-create most person contacts on import. Inline-create can be a fast-follow if wanted. Confirm before executing if you specifically need inline-create in PR A.
- **Types:** `counterpartyContactId` is a `number | null` on the model and the frontend `Transaction` type; the picker stores it as a string in select state and coerces to `number | null` in both `isDirty` and the patch — consistent with how `ownershipContactId` is handled.
- **No placeholders:** every code step shows the exact code; the one fixture-extension note (Step 2 of Task 2) is normal test setup, not a logic placeholder.
