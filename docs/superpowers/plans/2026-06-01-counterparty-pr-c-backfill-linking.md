# Counterparty PR C — Backfill contact-linking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Extend the existing counterparty backfill so it also find-or-creates + links a canonical `Contact` for person-to-person counterparties on pre-existing / CSV-imported rows (it currently only populates `counterparty_raw`).

**Architecture:** `runCounterpartyBackfill` ([backend/src/import/counterpartyBackfill.ts](../../../backend/src/import/counterpartyBackfill.ts)) changes its sweep filter from `counterparty_raw IS NULL` to `counterparty_contact_id IS NULL`, and for each in-scope row re-runs `extractCounterparty`; for `kind:'person'` it calls PR B's `resolveCounterpartyContact` (find-or-create by normalized name) and sets `counterparty_contact_id`, while still backfilling `counterparty_raw` when it was null. Each row's resolve+update runs in its OWN transaction so one row's failure can't abort the batch. Payroll/no-pattern rows stay unlinked (tracked in the paginate-past set). A `linked` counter joins the result + the `ProviderJobLog` summary.

**Tech Stack:** Sequelize, `node:test` + `tsx`, Postgres integration tests (`setupPgTestDb`).

**Spine note:** Counterparty primitive. No schema change (uses PR B's column/index/resolver). Not a spine change.

**Depends on PR B** (#476): `resolveCounterpartyContact`, the `contacts.normalized_name` migration + hook, `extractCounterparty {name,kind}`. This branch (`claude/counterparty-pr-c`) is stacked on PR B's branch.

---

## File Structure
- Modify: `backend/src/import/counterpartyBackfill.ts` — filter change, per-row resolve+link, `linked` count.
- Modify: `backend/test/integration/counterpartyBackfill.test.ts` — add contact-linking cases.
- Possibly modify: the route/status that surfaces the summary (additive `linked`) — only if needed to keep types compiling.

**Backend test command** (from `backend/`): `npx tsx --import ./test/setup.ts --test test/<path>.test.ts` (integration needs local Postgres, available). Typecheck `yarn typecheck`, lint `yarn lint`. Husky broken → `--no-verify`. No `Co-Authored-By`.

---

## Task 1: Extend `runCounterpartyBackfill` to link Contacts

**Files:** Modify `backend/src/import/counterpartyBackfill.ts`; Test `backend/test/integration/counterpartyBackfill.test.ts`.

READ the current `runCounterpartyBackfill` fully first (lines 153–331) — it has a `seenNullIds` paginate-past set, a per-batch plan→single-transaction-UPDATE structure, and `ProviderJobLog`. You are changing the sweep filter and moving the write into a per-row transaction that also resolves the Contact. Preserve: the per-household in-flight lock, dry-run semantics (no writes, no log), `ProviderJobLog` at the end, ordering, batching, and per-row error isolation (`skipped++` + `onError`, continue).

- [ ] **Step 1: Write the failing tests**

Add to `backend/test/integration/counterpartyBackfill.test.ts` (reuse the file's `makeAccount`/`makeTxn` helpers — `makeTxn` already accepts `counterpartyRaw`; confirm by reading the file). Call `runCounterpartyBackfill({ householdId })` directly (import it) and assert on the rows + `Contact` table afterward:

```ts
test('backfill links a person counterparty Contact on a raw-null row', async () => {
  const models = await import('../../src/models');
  const { runCounterpartyBackfill } = await import('../../src/import/counterpartyBackfill.js');
  const acc = await makeAccount({ householdId: householdAId, userId: userAId, name: 'Chk', accountType: 'checking' });
  const id = await makeTxn({ accountId: acc, householdId: householdAId, merchantRaw: 'INTERAC E-TRANSFER FROM JANE DOE REF 9' });
  const res = await runCounterpartyBackfill({ householdId: householdAId });
  assert.ok(res.linked >= 1);
  const row = await models.Transaction.findByPk(id);
  assert.equal(row!.counterpartyRaw, 'JANE DOE');
  assert.ok(row!.counterpartyContactId, 'contact linked');
  const contact = await models.Contact.findByPk(row!.counterpartyContactId!);
  assert.equal(contact!.normalizedName, 'jane doe');
});

test('backfill links a row that already has counterpartyRaw but no contact', async () => {
  const models = await import('../../src/models');
  const { runCounterpartyBackfill } = await import('../../src/import/counterpartyBackfill.js');
  const acc = await makeAccount({ householdId: householdAId, userId: userAId, name: 'Chk2', accountType: 'checking' });
  const id = await makeTxn({ accountId: acc, householdId: householdAId, merchantRaw: 'ZELLE PAYMENT TO MIKE SMITH', counterpartyRaw: 'MIKE SMITH' });
  await runCounterpartyBackfill({ householdId: householdAId });
  const row = await models.Transaction.findByPk(id);
  assert.ok(row!.counterpartyContactId, 'existing-raw row got linked');
});

test('backfill leaves payroll rows raw-only (no contact)', async () => {
  const models = await import('../../src/models');
  const { runCounterpartyBackfill } = await import('../../src/import/counterpartyBackfill.js');
  const acc = await makeAccount({ householdId: householdAId, userId: userAId, name: 'Chk3', accountType: 'checking' });
  const id = await makeTxn({ accountId: acc, householdId: householdAId, merchantRaw: 'PAYROLL DEPOSIT ACME CORP' });
  await runCounterpartyBackfill({ householdId: householdAId });
  const row = await models.Transaction.findByPk(id);
  assert.equal(row!.counterpartyRaw, 'ACME CORP');
  assert.equal(row!.counterpartyContactId, null);
});

test('backfill is idempotent and dedupes across rows', async () => {
  const models = await import('../../src/models');
  const { runCounterpartyBackfill } = await import('../../src/import/counterpartyBackfill.js');
  const acc = await makeAccount({ householdId: householdAId, userId: userAId, name: 'Chk4', accountType: 'checking' });
  await makeTxn({ accountId: acc, householdId: householdAId, merchantRaw: 'INTERAC E-TRANSFER TO JOHN DOE REF 1' });
  await makeTxn({ accountId: acc, householdId: householdAId, merchantRaw: 'INTERAC E-TRANSFER TO JOHN DOE REF 2' });
  await runCounterpartyBackfill({ householdId: householdAId });
  await runCounterpartyBackfill({ householdId: householdAId }); // second run = no-op
  const count = await models.Contact.count({ where: { householdId: householdAId, normalizedName: 'john doe' } });
  assert.equal(count, 1, 'one contact for both rows, no duplicate on re-run');
});

test('backfill dryRun writes nothing', async () => {
  const models = await import('../../src/models');
  const { runCounterpartyBackfill } = await import('../../src/import/counterpartyBackfill.js');
  const acc = await makeAccount({ householdId: householdAId, userId: userAId, name: 'Chk5', accountType: 'checking' });
  const id = await makeTxn({ accountId: acc, householdId: householdAId, merchantRaw: 'VENMO FROM SARAH LEE' });
  const before = await models.Contact.count({ where: { householdId: householdAId } });
  await runCounterpartyBackfill({ householdId: householdAId, dryRun: true });
  const row = await models.Transaction.findByPk(id);
  assert.equal(row!.counterpartyContactId, null);
  assert.equal(await models.Contact.count({ where: { householdId: householdAId } }), before);
});
```
Wipe state at the start of these tests the way the existing suite does (the file already destroys Transaction/Account/ProviderJobLog between cases — follow that pattern, and also `Contact.destroy({ where: {}, force: true })`).

- [ ] **Step 2: Run, verify they FAIL** — `npx tsx --import ./test/setup.ts --test test/integration/counterpartyBackfill.test.ts` → the new linking tests fail (`res.linked` undefined / `counterpartyContactId` null).

- [ ] **Step 3: Implement.** In `backend/src/import/counterpartyBackfill.ts`:
  1. Import the resolver: `import { resolveCounterpartyContact } from '../contacts/findOrCreateContact';`
  2. Add `linked` to `CounterpartyBackfillResult` (and the `summary`): `linked: number;`
  3. Change the sweep `where` from `counterpartyRaw: { [Op.is]: null }` to `counterpartyContactId: { [Op.is]: null }`. Keep the in-scope account include + ordering + the paginate-past set (rename `seenNullIds` → `seenIds`; it now means "processed but still counterparty_contact_id IS NULL", i.e. payroll + no-pattern rows).
  4. Carry `counterpartyRaw` into the materialised `TxnRow` (add `counterpartyRaw: string | null`).
  5. Replace the plan-then-batch-update block with a per-row loop where each row's resolve+update is its OWN transaction (so a unique-violation/error on one row rolls back only that row):
```ts
      for (const r of rows) {
        processed++;
        try {
          const cp = extractCounterparty(r.merchantRaw, r.accountType);
          if (cp == null) {
            seenIds.add(r.id);
            callbacks.onProgress?.({ txnId: r.id, merchantRaw: r.merchantRaw, counterpartyRaw: null });
            continue;
          }
          const rawWasNull = r.counterpartyRaw == null;
          if (dryRun) {
            if (rawWasNull) extracted++;
            seenIds.add(r.id); // nothing written → stays contactId NULL
            callbacks.onProgress?.({ txnId: r.id, merchantRaw: r.merchantRaw, counterpartyRaw: cp.name });
            continue;
          }
          await sequelize.transaction(async (t) => {
            let contactId: number | null = null;
            if (cp.kind === 'person') {
              contactId = await resolveCounterpartyContact(householdId, cp, { transaction: t });
            }
            const patch: Record<string, unknown> = {};
            if (rawWasNull) patch.counterpartyRaw = cp.name;
            if (contactId != null) patch.counterpartyContactId = contactId;
            if (Object.keys(patch).length > 0) {
              await Transaction.update(patch, {
                where: { id: r.id, counterpartyContactId: { [Op.is]: null } },
                transaction: t,
              });
            }
            if (rawWasNull) extracted++;
            if (contactId != null) linked++;
            else seenIds.add(r.id); // payroll: stays contactId NULL, paginate past it
          });
          callbacks.onProgress?.({ txnId: r.id, merchantRaw: r.merchantRaw, counterpartyRaw: cp.name });
        } catch (err) {
          skipped++;
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err, txnId: r.id, module: 'counterparty_backfill' }, 'counterparty_backfill_row_failed');
          callbacks.onError?.({ txnId: r.id, message });
          seenIds.add(r.id); // don't loop forever on a row that keeps throwing
        }
      }
```
  6. Initialise `let linked = 0;` next to `extracted`. Include `linked` in the `summary` object, the final `ProviderJobLog` summary, and the returned result.
  7. Update the doc comment at the top of the file (it says it walks `counterparty_raw IS NULL` and that the Contact link is set elsewhere) to reflect that it now also links person Contacts via `resolveCounterpartyContact`, deduped by normalized name, payroll excluded.

- [ ] **Step 4: Run the tests, verify PASS** — `npx tsx --import ./test/setup.ts --test test/integration/counterpartyBackfill.test.ts` → all (existing + new) PASS. If an existing test asserted `res` shape without `linked`, it still passes (additive). If the existing streaming-route test asserted exact `processed` counts, confirm the filter change didn't alter them for its fixtures (its in-scope rows had `counterpartyRaw IS NULL` and no contact, so they're still swept) — update only if a count legitimately changed and explain.

- [ ] **Step 5: Typecheck + lint** — `yarn typecheck` clean; `yarn lint` no new warnings. If `getLastCounterpartyBackfillRun`'s summary type or the route response needs `linked` to compile, add it (additive, default 0 for legacy log rows).

- [ ] **Step 6: Commit**
```bash
git add backend/src/import/counterpartyBackfill.ts backend/test/integration/counterpartyBackfill.test.ts
git commit -m "feat(import): backfill find-or-creates + links person counterparty Contacts"
```

---

## Task 2: Verify + open PR

- [ ] **Step 1: Full gate** (from `backend/`)
  - `yarn typecheck` clean; `yarn lint` clean.
  - `npx tsx --import ./test/setup.ts --test test/integration/counterpartyBackfill.test.ts test/integration/counterpartyImportAutolink.test.ts test/integration/transactionCounterpartyPromote.test.ts test/integration/contacts.test.ts` → all PASS.

- [ ] **Step 2: Push + PR (stacked on PR B, auto-merge merge-commit)**
```bash
git push -u origin refs/heads/claude/counterparty-pr-c:refs/heads/claude/counterparty-pr-c
```
Then (run `gh` separately — a hook blocks Bash commands containing both a push and the word "main"):
```bash
gh pr create --base main --head claude/counterparty-pr-c --title "feat(counterparty): backfill links person Contacts (PR C)" --body "Extends counterpartyBackfill to find-or-create + link person Contacts retroactively (previously raw-only), reusing PR B's resolver. Covers pre-existing + CSV-imported rows. Stacks on #476 (PR B); diff reduces to just PR C once #476 merges. 5 new integration tests. Spec: docs/superpowers/specs/2026-05-31-canonical-counterparty-on-transactions-design.md"
gh pr merge --auto --merge
```
(PR C's diff vs main will include PR B's commits until #476 merges — that's expected for a stacked PR. Auto-merge lands #476 first, then PR C's diff becomes just its own changes and it merges.)

---

## Self-review (completed during planning)
- **Spec coverage:** Implements spec §"PR C — Backfill": broaden scope to `counterparty_contact_id IS NULL`, ensure raw (extract if missing), link person-kind via the resolver, preserve dry-run + `ProviderJobLog` + per-household lock.
- **Failure isolation:** per-row transaction (not the original per-batch) so a single row's resolver error / unique-violation rolls back only that row and the sweep continues — important because the resolver now does DB writes that can fail.
- **Termination:** `seenIds` now tracks payroll + no-pattern + errored rows (everything that stays `counterparty_contact_id IS NULL`), so the `WHERE counterparty_contact_id IS NULL` sweep paginates past them instead of looping.
- **Idempotency:** re-runs find existing contacts (find-or-create) and the `WHERE counterparty_contact_id IS NULL` write-guard prevents relinking; dedupe across rows via the normalized unique index.
- **Additive result shape:** `linked` added to result + summary; legacy `ProviderJobLog` rows lacking it default to 0 in `getLastCounterpartyBackfillRun`.
