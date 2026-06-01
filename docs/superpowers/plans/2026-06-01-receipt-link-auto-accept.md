# Receipt Link Auto-Accept Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-accept unambiguous, high-confidence receipt→transaction links at match time so clean matches show as "Linked" with zero clicks, and backfill existing stranded `suggested` links.

**Architecture:** Add a pure predicate `decideAutoAccept(sortedConfidences[])` to the receipt matcher; the matcher sets new/updated `TransactionOrderLink.status` from it (`accepted` vs `suggested`), upgrading stale `suggested` links on re-run without ever downgrading `accepted`/`rejected`. A backfill script re-runs the matcher over orders that still have `suggested` links — the same upgrade path, no rule duplication.

**Tech Stack:** TypeScript, Sequelize 6 (SQLite dev/test, Postgres prod), `node:test` via `tsx`, existing `scoreReceiptMatch`/`txnMatchesVendor` helpers.

**Spec:** `docs/superpowers/specs/2026-06-01-receipt-link-auto-accept-design.md`

---

## File Structure

- **Modify** `backend/src/import/matchReceiptToTransactions.ts` — add `AUTO_ACCEPT_THRESHOLD`/`AUTO_ACCEPT_MARGIN` constants + exported `decideAutoAccept()`; set link status from it in the create and update branches of `matchReceiptOrderToTransactions`.
- **Modify** `backend/test/matchReceiptToTransactions.test.ts` — append `decideAutoAccept` unit tests (pure, no DB; matches the file's existing style).
- **Create** `backend/test/matchReceiptOrderToTransactions.test.ts` — DB-backed integration tests for the orchestrator's status behavior (mirrors `test/loadItemAllocations.test.ts` setup).
- **Create** `backend/scripts/backfill-receipt-link-acceptance.ts` — one-off re-match over orders with suggested links; dry-run default, `--commit` to write.

The diagnostic `backend/scripts/diagnose-costco-receipt-links.ts` and the spec are already committed.

---

## Task 1: `decideAutoAccept` pure predicate

**Files:**
- Modify: `backend/src/import/matchReceiptToTransactions.ts` (constants near `MATCH_CONFIDENCE_THRESHOLD` line 22; export the function)
- Test: `backend/test/matchReceiptToTransactions.test.ts` (append)

- [ ] **Step 1: Write the failing tests** — append to `backend/test/matchReceiptToTransactions.test.ts`:

```ts
import {
  scoreReceiptMatch,
  txnMatchesVendor,
  decideAutoAccept,
  type CandidatePayment,
} from '../src/import/matchReceiptToTransactions';
// NOTE: add `decideAutoAccept` to the EXISTING import block at the top of the file
// (lines 3-7); do not duplicate the import. Shown here in full for clarity.

test('decideAutoAccept: single candidate at/above threshold accepts', () => {
  assert.equal(decideAutoAccept([85]), true);
  assert.equal(decideAutoAccept([90]), true);
  assert.equal(decideAutoAccept([100]), true);
});

test('decideAutoAccept: single candidate below threshold stays suggested', () => {
  assert.equal(decideAutoAccept([84]), false);
  assert.equal(decideAutoAccept([70]), false);
});

test('decideAutoAccept: two equal high candidates are ambiguous → false', () => {
  assert.equal(decideAutoAccept([90, 90]), false);
});

test('decideAutoAccept: clear margin over runner-up accepts', () => {
  assert.equal(decideAutoAccept([90, 75]), true); // margin 15 > 10
});

test('decideAutoAccept: thin margin over runner-up stays suggested', () => {
  assert.equal(decideAutoAccept([90, 82]), false); // margin 8, not > 10
  assert.equal(decideAutoAccept([90, 80]), false); // margin 10, not > 10 (strict)
});

test('decideAutoAccept: empty input → false', () => {
  assert.equal(decideAutoAccept([]), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/matchReceiptToTransactions.test.ts`
Expected: FAIL — `decideAutoAccept` is not exported (TypeScript/runtime error "does not provide an export named 'decideAutoAccept'").

- [ ] **Step 3: Implement the predicate** — in `backend/src/import/matchReceiptToTransactions.ts`, directly below the existing line 23 `const DATE_WINDOW_DAYS = 7;` add:

```ts
const AUTO_ACCEPT_THRESHOLD = 85; // exact-amount match baseline is 90 (50 amount + 25 date + 15 vendor)
const AUTO_ACCEPT_MARGIN = 10;    // best must lead runner-up by MORE than this to be unambiguous

/**
 * Decide whether the top-scored candidate for a single payment is safe to
 * auto-accept: high enough confidence AND unambiguous (sole qualifier, or a
 * clear margin over the runner-up). `sortedConfidences` is the per-payment
 * candidate confidences, already filtered to >= MATCH_CONFIDENCE_THRESHOLD and
 * sorted descending. Pure — no DB, no model coupling.
 */
export function decideAutoAccept(sortedConfidences: number[]): boolean {
  if (sortedConfidences.length === 0) return false;
  if (sortedConfidences[0] < AUTO_ACCEPT_THRESHOLD) return false;
  if (sortedConfidences.length === 1) return true;
  return sortedConfidences[0] - sortedConfidences[1] > AUTO_ACCEPT_MARGIN;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/matchReceiptToTransactions.test.ts`
Expected: PASS — all existing scorer tests plus the 6 new `decideAutoAccept` tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/gracious-ramanujan-b79045
git add backend/src/import/matchReceiptToTransactions.ts backend/test/matchReceiptToTransactions.test.ts
git commit -m "feat(receipts): add decideAutoAccept predicate for high-confidence links"
```

---

## Task 2: Wire auto-accept into the matcher

**Files:**
- Modify: `backend/src/import/matchReceiptToTransactions.ts` (the per-payment loop in `matchReceiptOrderToTransactions`, lines ~180-214)
- Test: `backend/test/matchReceiptOrderToTransactions.test.ts` (create)

- [ ] **Step 1: Write the failing integration tests** — create `backend/test/matchReceiptOrderToTransactions.test.ts`:

```ts
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  sequelize,
  Account,
  Transaction,
  ExternalOrder,
  ExternalOrderTender,
  TransactionOrderLink,
} from '../src/models';
import { matchReceiptOrderToTransactions } from '../src/import/matchReceiptToTransactions';

const HH = 1;
let accountId: number;
let fp = 0;

before(async () => {
  await sequelize.sync({ force: true });
  const account = await Account.create({ name: 'Test', householdId: HH } as never);
  accountId = account.id;
});

beforeEach(async () => {
  // Isolate each test: wipe links/orders/txns (keep the account).
  await TransactionOrderLink.destroy({ where: {} });
  await ExternalOrderTender.destroy({ where: {} });
  await ExternalOrder.destroy({ where: {} });
  await Transaction.destroy({ where: {} });
});

async function mkTxn(opts: { amount: string; date: string; merchant?: string }): Promise<Transaction> {
  fp += 1;
  return Transaction.create({
    accountId,
    householdId: HH,
    importBatch: 'test',
    date: opts.date,
    merchantRaw: opts.merchant ?? 'COSTCO WHOLESALE W1168 GUELPH ON',
    merchantClean: opts.merchant ?? 'Costco',
    amount: opts.amount,
    currency: 'CAD',
    sourceRowFingerprint: `fp-${fp}`,
    sourceIdentityFingerprint: `sif-${fp}`,
  } as never);
}

async function mkOrder(opts: { orderDate: string; total: string; last4?: string }): Promise<ExternalOrder> {
  return ExternalOrder.create({
    vendor: 'costco',
    householdId: HH,
    dedupeKey: `dk-${opts.orderDate}-${opts.total}`,
    orderDate: opts.orderDate,
    total: opts.total,
    paymentLast4: opts.last4 ?? null,
    currency: 'CAD',
    source: 'test',
  } as never);
}

test('single exact-amount match → link created accepted', async () => {
  await mkTxn({ amount: '-947.04', date: '2025-12-15' });
  const order = await mkOrder({ orderDate: '2025-12-13', total: '947.04' });

  const res = await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId: HH });
  assert.equal(res.created, 1);
  const links = await TransactionOrderLink.findAll({ where: { externalOrderId: order.id } });
  assert.equal(links.length, 1);
  assert.equal(links[0].status, 'accepted');
});

test('two same-amount candidates in window → ambiguous, stays suggested', async () => {
  await mkTxn({ amount: '-947.04', date: '2025-12-14' });
  await mkTxn({ amount: '-947.04', date: '2025-12-15' });
  const order = await mkOrder({ orderDate: '2025-12-13', total: '947.04' });

  await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId: HH });
  const links = await TransactionOrderLink.findAll({ where: { externalOrderId: order.id } });
  assert.equal(links.length, 1, 'one tender → one best link');
  assert.equal(links[0].status, 'suggested');
});

test('amount-within-$2-only match (confidence < 85) → suggested', async () => {
  // amount diff $1.50 → 35 pts; same-ish date 25; vendor 15 = 75 (>=70 link, <85 no auto-accept)
  await mkTxn({ amount: '-948.54', date: '2025-12-15' });
  const order = await mkOrder({ orderDate: '2025-12-13', total: '947.04' });

  await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId: HH });
  const links = await TransactionOrderLink.findAll({ where: { externalOrderId: order.id } });
  assert.equal(links.length, 1);
  assert.equal(links[0].status, 'suggested');
});

test('re-run upgrades a stale suggested link to accepted', async () => {
  const txn = await mkTxn({ amount: '-947.04', date: '2025-12-15' });
  const order = await mkOrder({ orderDate: '2025-12-13', total: '947.04' });
  // Pre-existing suggested link (simulates pre-feature data).
  await TransactionOrderLink.create({
    transactionId: txn.id,
    externalOrderId: order.id,
    confidence: '90',
    matchReason: 'old',
    status: 'suggested',
    linkedAmount: '947.04',
  } as never);

  const res = await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId: HH });
  assert.equal(res.updated, 1);
  const link = await TransactionOrderLink.findOne({ where: { externalOrderId: order.id } });
  assert.equal(link?.status, 'accepted');
});

test('re-run does NOT downgrade accepted or resurrect rejected', async () => {
  const txn = await mkTxn({ amount: '-947.04', date: '2025-12-15' });
  const order = await mkOrder({ orderDate: '2025-12-13', total: '947.04' });
  await TransactionOrderLink.create({
    transactionId: txn.id, externalOrderId: order.id,
    confidence: '90', matchReason: 'm', status: 'rejected', linkedAmount: '947.04',
  } as never);

  await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId: HH });
  const link = await TransactionOrderLink.findOne({ where: { externalOrderId: order.id } });
  assert.equal(link?.status, 'rejected', 'rejected link must not be resurrected');
});

test('split-tender: both unambiguous tenders accepted (order-398 shape)', async () => {
  await mkTxn({ amount: '-1863.72', date: '2025-12-27' });
  await mkTxn({ amount: '-1100.00', date: '2025-12-29' });
  const order = await mkOrder({ orderDate: '2025-12-26', total: '2963.72' });
  await ExternalOrderTender.create({ externalOrderId: order.id, sequence: 0, paymentLast4: '3812', amount: '1863.72' } as never);
  await ExternalOrderTender.create({ externalOrderId: order.id, sequence: 1, paymentLast4: null, amount: '1100.00' } as never);

  const res = await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId: HH });
  assert.equal(res.created, 2);
  const links = await TransactionOrderLink.findAll({ where: { externalOrderId: order.id } });
  assert.equal(links.length, 2);
  assert.ok(links.every((l) => l.status === 'accepted'), 'both tenders should auto-accept');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/matchReceiptOrderToTransactions.test.ts`
Expected: FAIL — the matcher still hardcodes `status: 'suggested'`, so the "accepted" assertions fail (e.g. `'suggested' !== 'accepted'`).

- [ ] **Step 3: Wire `decideAutoAccept` into the matcher** — in `backend/src/import/matchReceiptToTransactions.ts`, inside the `for (const payment of payments)` loop, replace the block from `const best = scored[0];` through `claimed.add(best.txn.id);` with:

```ts
    if (scored.length === 0) continue;
    const best = scored[0];
    const autoAccept = decideAutoAccept(scored.map((s) => s.confidence));

    const [link, isNew] = await TransactionOrderLink.findOrCreate({
      where: { transactionId: best.txn.id, externalOrderId: order.id },
      defaults: {
        transactionId: best.txn.id,
        externalOrderId: order.id,
        confidence: String(best.confidence),
        matchReason: best.matchReason,
        status: autoAccept ? 'accepted' : 'suggested',
        linkedAmount: String(payment.amount),
      },
    });

    if (isNew) {
      created += 1;
    } else if (link.status === 'suggested') {
      await link.update({
        confidence: String(best.confidence),
        matchReason: best.matchReason,
        linkedAmount: String(payment.amount),
        ...(autoAccept ? { status: 'accepted' as const } : {}),
      });
      updated += 1;
    }
    claimed.add(best.txn.id);
```

(The `if (scored.length === 0) continue;` line is unchanged — included for an unambiguous anchor.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/matchReceiptOrderToTransactions.test.ts`
Expected: PASS — all 6 integration tests.

- [ ] **Step 5: Run the existing matcher unit tests (no regression)**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/matchReceiptToTransactions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/gracious-ramanujan-b79045
git add backend/src/import/matchReceiptToTransactions.ts backend/test/matchReceiptOrderToTransactions.test.ts
git commit -m "feat(receipts): auto-accept high-confidence receipt-to-transaction links at match time"
```

---

## Task 3: Backfill script

**Files:**
- Create: `backend/scripts/backfill-receipt-link-acceptance.ts`

Dry-run lists the orders that have `suggested` links (the scope). `--commit` re-runs the matcher per order — which upgrades qualifying `suggested` links via Task 2's update branch — and reports the per-order change in `accepted` count. No rule duplication: the accept decision lives only in the matcher.

- [ ] **Step 1: Write the script**

```ts
#!/usr/bin/env tsx
/**
 * Backfill auto-acceptance for receipt→transaction links created before the
 * auto-accept feature. Finds every ExternalOrder that still has a 'suggested'
 * TransactionOrderLink and re-runs matchReceiptOrderToTransactions, which
 * upgrades qualifying suggested links to 'accepted' (monotonic — never
 * downgrades 'accepted'/'rejected').
 *
 * Usage:
 *   cd backend && DATABASE_URL=... npx tsx scripts/backfill-receipt-link-acceptance.ts          # dry-run
 *   cd backend && DATABASE_URL=... npx tsx scripts/backfill-receipt-link-acceptance.ts --commit # write
 *
 * Prod Postgres only (per project convention). Without DATABASE_URL this hits
 * local sqlite — do not run the backfill that way.
 */
import { Op } from 'sequelize';
import { ExternalOrder, TransactionOrderLink, sequelize } from '../src/models';
import { matchReceiptOrderToTransactions } from '../src/import/matchReceiptToTransactions';

const COMMIT = process.argv.includes('--commit');

async function acceptedCount(orderId: number): Promise<number> {
  return TransactionOrderLink.count({ where: { externalOrderId: orderId, status: 'accepted' } });
}

async function main() {
  const suggested = await TransactionOrderLink.findAll({
    where: { status: 'suggested' },
    attributes: ['externalOrderId'],
    group: ['externalOrderId'],
  });
  const orderIds = suggested.map((l) => l.externalOrderId);
  const orders = await ExternalOrder.findAll({ where: { id: { [Op.in]: orderIds } }, order: [['id', 'ASC']] });

  console.log(`${orders.length} order(s) with suggested link(s).${COMMIT ? '' : '  [dry-run — pass --commit to write]'}`);

  let upgradedLinks = 0;
  for (const order of orders) {
    if (order.householdId == null) {
      console.log(`  order ${order.id}: skipped (no householdId)`);
      continue;
    }
    const before = await acceptedCount(order.id);
    if (!COMMIT) {
      console.log(`  order ${order.id} (${order.vendor}, ${order.orderDate}): would re-match; currently ${before} accepted`);
      continue;
    }
    await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId: order.householdId });
    const after = await acceptedCount(order.id);
    upgradedLinks += Math.max(0, after - before);
    console.log(`  order ${order.id} (${order.vendor}, ${order.orderDate}): accepted ${before} → ${after}`);
  }

  if (COMMIT) console.log(`\nUpgraded ${upgradedLinks} link(s) to accepted.`);
  await sequelize.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck the script compiles**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS (no type errors). If `order.householdId` is typed `number | null`, the null-guard above narrows it.

- [ ] **Step 3: Dry-run smoke against a throwaway local DB (no prod, no writes)**

Run: `cd backend && npx tsx scripts/backfill-receipt-link-acceptance.ts`
Expected: connects to local sqlite (empty), prints `0 order(s) with suggested link(s).  [dry-run ...]`, exits 0. Confirms the script runs and is a no-op without `--commit`.

- [ ] **Step 4: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/gracious-ramanujan-b79045
git add backend/scripts/backfill-receipt-link-acceptance.ts
git commit -m "feat(receipts): add backfill script to auto-accept stranded suggested links"
```

---

## Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 2: Lint the changed source**

Run: `cd backend && npx eslint src/import/matchReceiptToTransactions.ts`
Expected: PASS (no errors). Fix any lint findings and re-run.

- [ ] **Step 3: Run the full backend unit suite (no regressions)**

Run: `cd backend && npm test`
Expected: PASS — including the new `decideAutoAccept` and `matchReceiptOrderToTransactions` tests.

- [ ] **Step 4: Push and open PR with auto-merge**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/gracious-ramanujan-b79045
git push -u origin claude/gracious-ramanujan-b79045
gh pr create --title "feat(receipts): auto-accept high-confidence receipt links" \
  --body "$(cat <<'EOF'
## What
Auto-accept unambiguous, high-confidence receipt→transaction links at match time
(`decideAutoAccept`: confidence ≥ 85 AND sole candidate or >10 margin over runner-up),
so clean matches show as **Linked** with zero clicks. Adds a backfill script for
existing stranded `suggested` links.

## Why
Root cause: the matcher created links as `suggested`, and only the Amazon page can
flip a link to `accepted`. Non-Amazon receipts (Costco) were stranded as `needs_match`
despite correct conf-90 matches. See spec `docs/superpowers/specs/2026-06-01-receipt-link-auto-accept-design.md`.

## Scope
- `matchReceiptToTransactions.ts`: `decideAutoAccept` + status wiring (monotonic upgrade; never downgrades accepted/rejected).
- Backfill script `backfill-receipt-link-acceptance.ts` (dry-run default).
- NOT changed: manual accept UI, `amazon/matcher.ts`, `/api/order-links` fold (out of scope per spec).

## Test
- Unit: `decideAutoAccept` (threshold, margin, ambiguity, empty).
- Integration (sync'd sqlite): exact→accepted, ambiguous→suggested, <85→suggested, re-run upgrade, no-downgrade/no-resurrect, split-tender both accepted.
EOF
)"
gh pr merge --auto --merge
```

Expected: PR created, auto-merge (merge commit) enabled. If `gh pr merge` reports auto-merge is disabled on the repo, enable it: `gh api -X PATCH repos/Connor-Adams/cashflow -f allow_auto_merge=true`, then re-run `gh pr merge --auto --merge`.

- [ ] **Step 5: Post-merge prod backfill (after CI merges)**

```bash
cd backend
DBURL=$(railway variables --service Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
DATABASE_URL="$DBURL" npx tsx scripts/backfill-receipt-link-acceptance.ts            # dry-run, eyeball
DATABASE_URL="$DBURL" npx tsx scripts/backfill-receipt-link-acceptance.ts --commit   # write
```

Expected: dry-run lists orders with suggested links; `--commit` reports per-order `accepted` deltas. Then spot-check with `DATABASE_URL="$DBURL" npx tsx scripts/diagnose-costco-receipt-links.ts`.

---

## Self-Review notes

- **Spec coverage:** `decideAutoAccept` (Task 1) ↔ spec §1; matcher wiring + monotonic upgrade (Task 2) ↔ spec §2; backfill (Task 3) ↔ spec §3; tests (Tasks 1-2) ↔ spec Testing list ①–⑫; verification + diagnostic (Task 4) ↔ spec Verification. Out-of-scope items intentionally absent.
- **Backfill dry-run refinement:** the spec wording "links that would upgrade vs left suggested" is realized as: dry-run lists in-scope orders; `--commit` reports the per-order `accepted` count delta. This avoids duplicating the accept rule outside the matcher (a spec goal). Minor, noted for the reviewer.
- **Type consistency:** `decideAutoAccept(number[])` used identically in Task 1 (definition + tests) and Task 2 (`scored.map((s) => s.confidence)`). Status string `'accepted'` matches `amazon.ts` and `deriveLinkStatus`.
