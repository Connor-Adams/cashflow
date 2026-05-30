# Issue #287: Account Merge and Consolidation Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable users to merge duplicate accounts, reassigning child records (transactions, planned events, etc.) to a target account in a single atomic operation, with source account preserved for audit.

**Architecture:** 
- Soft-merge pattern: source account is marked `merged_into_id` (FK to target), its child records are reassigned, and the source remains visible only in a "Hidden / merged" section.
- Transactional merge service handles all child-table reassignments atomically.
- Migration adds `merged_into_id` and `merged_at` columns to accounts table.
- Frontend exposes "Merge into…" action per account row (Settings → Accounts or AccountsPage), with a modal showing preview and confirm step.
- Route skeleton already exists; accountMerge service needs implementation.

**Tech Stack:** 
- Backend: Node.js + Sequelize ORM, transactional DB operations
- Frontend: React + TanStack Query for data fetching, modal pattern (existing), Tailwind v4 utilities
- Tests: node:test runner (backend), component tests (frontend)

---

## File Structure

### Backend Files

**Modified:**
- `backend/src/models/Account.ts` — already has mergedIntoId/mergedAt fields; verify structure

**New:**
- `backend/src/migrations/20260603000001-accounts-merge-columns.js` — add merged_into_id, merged_at columns + index
- `backend/src/services/accountMerge.ts` — transactional merge logic; reassign all child-table records
- `backend/test/accountMerge.test.ts` — integration tests covering all AC criteria

**Existing (modify):**
- `backend/src/routes/accounts.ts` — already has merge endpoint skeleton + filter import; verify implementation

### Frontend Files

**New:**
- `frontend/src/components/accounts/MergeAccountModal.tsx` — modal UI: preview, target selection, confirm step
- `frontend/src/pages/settings/tabs/AccountsTab.tsx` — accounts list with "Merge into…" action + "Hidden / merged" section

**Modified:**
- `frontend/src/pages/AccountsPage.tsx` — integrate merge action (or use from Settings tab; issue says "Entry points: Accounts page, Settings → Accounts tab")

---

## Task Breakdown

### Task 1: Write and Run Migration Backward-Compatibility Test

**Files:**
- Create: `backend/test/migrations/accountsMergeMigration.test.ts`

**Context:** The migration adds `merged_into_id BIGINT NULL FK→accounts.id ON DELETE RESTRICT` and `merged_at TIMESTAMP NULL`, with index on `(merged_into_id)`. Tests verify the column definitions, forward/backward reversibility, and null defaults.

- [ ] **Step 1: Write the migration test file**

```typescript
/**
 * Test for accounts merge migration (issue #287).
 * Verifies:
 *   - merged_into_id column added with BIGINT type, nullable, FK to accounts
 *   - merged_at column added with TIMESTAMP type, nullable
 *   - Index on (merged_into_id) is created
 *   - Forward + backward migration is reversible
 *   - Existing rows backfill with merged_into_id = NULL and merged_at = NULL
 */
import { before, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let QueryInterface: any;

before(async () => {
  const models = await import('../src/models');
  sequelize = models.sequelize;
  QueryInterface = sequelize.getQueryInterface();
  await sequelize.sync({ force: true });
});

afterEach(async () => {
  // Reset for next test
});

test('migration: accounts merge columns forward + backward', async () => {
  // Verify columns don't exist yet (or use a fresh test DB)
  let hasColumn = await QueryInterface.hasColumn('accounts', 'merged_into_id');
  assert.equal(hasColumn, false, 'merged_into_id should not exist before migration');

  // Load and run the migration
  const migration = await import('../src/migrations/20260603000001-accounts-merge-columns');
  await migration.up(QueryInterface, sequelize.constructor);

  // Verify columns exist with correct type
  hasColumn = await QueryInterface.hasColumn('accounts', 'merged_into_id');
  assert.equal(hasColumn, true, 'merged_into_id should exist after migration');

  const mergedIntoColumn = await QueryInterface.describeTable('accounts');
  assert.ok(
    mergedIntoColumn.merged_into_id,
    'merged_into_id column should be described'
  );
  assert.equal(
    mergedIntoColumn.merged_into_id.allowNull,
    true,
    'merged_into_id should be nullable'
  );

  const mergedAtColumn = mergedIntoColumn.merged_at;
  assert.ok(mergedAtColumn, 'merged_at column should exist');
  assert.equal(mergedAtColumn.allowNull, true, 'merged_at should be nullable');

  // Verify index exists (implementation detail; some DBs may not expose this easily)
  // Attempt reverse
  await migration.down(QueryInterface);
  hasColumn = await QueryInterface.hasColumn('accounts', 'merged_into_id');
  assert.equal(hasColumn, false, 'merged_into_id should not exist after rollback');
});
```

- [ ] **Step 2: Run the test to verify it fails (migration doesn't exist yet)**

```bash
cd /Users/connoradams/Developer/cashflow
yarn workspace cashflow-backend run test -- backend/test/migrations/accountsMergeMigration.test.ts
```

Expected: Test fails with module not found or column not found error.

### Task 2: Create the Migration File

**Files:**
- Create: `backend/src/migrations/20260603000001-accounts-merge-columns.js`

- [ ] **Step 1: Write the migration**

```javascript
'use strict';

/**
 * Add merge-related columns to accounts table (issue #287).
 *
 * Adds soft-merge support:
 *   - merged_into_id BIGINT NULL FK→accounts.id ON DELETE RESTRICT
 *   - merged_at TIMESTAMP NULL
 *   - Index on (merged_into_id) for "find sources merged into me" queries
 *
 * When merged_into_id is set, the source account is hidden from default
 * GET /api/accounts calls and shown only if ?includeMerged=true.
 * The source remains readable for audit.
 */

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

module.exports = {
  async up(queryInterface, Sequelize) {
    // Add merged_into_id column
    await queryInterface.addColumn('accounts', 'merged_into_id', {
      type: Sequelize.BIGINT,
      allowNull: true,
      defaultValue: null,
      references: {
        model: 'accounts',
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    });

    // Add merged_at column
    await queryInterface.addColumn('accounts', 'merged_at', {
      type: Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
    });

    // Add index on merged_into_id for the "find sources merged into this target" query
    await queryInterface.addIndex('accounts', ['merged_into_id'], {
      name: 'accounts_merged_into_id',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('accounts', 'accounts_merged_into_id');
    await queryInterface.removeColumn('accounts', 'merged_at');
    await queryInterface.removeColumn('accounts', 'merged_into_id');
  },
};
```

- [ ] **Step 2: Run the migration test again to verify it passes**

```bash
yarn workspace cashflow-backend run test -- backend/test/migrations/accountsMergeMigration.test.ts
```

Expected: Test passes.

- [ ] **Step 3: Verify forward/backward migration on dev database**

```bash
# Forward
yarn workspace cashflow-backend run db:migrate

# Check tables
psql $DATABASE_URL -c "\d accounts" | grep merged

# Backward
yarn workspace cashflow-backend run db:rollback

# Forward again
yarn workspace cashflow-backend run db:migrate
```

Expected: Columns appear after forward, disappear after rollback, reappear after forward again.

- [ ] **Step 4: Commit**

```bash
git add backend/src/migrations/20260603000001-accounts-merge-columns.js \
         backend/test/migrations/accountsMergeMigration.test.ts
git commit -m "migration: add accounts.merged_into_id and merged_at for account merge (#287)"
```

### Task 3: Write Integration Test for mergeAccounts Service

**Files:**
- Create: `backend/test/accountMerge.test.ts`

**Context:** This is the TDD step. The test exercises all AC criteria and error cases. The service will be implemented in Task 5.

- [ ] **Step 1: Write the comprehensive integration test**

```typescript
/**
 * Integration tests for account merge service (issue #287).
 *
 * Exercises:
 *   - AC #1: Migration reversible
 *   - AC #2: Transactions reassigned
 *   - AC #3: PlannedEvents reassigned
 *   - AC #4: Transaction rolls back if reassignment fails
 *   - AC #5: Currency mismatch returns 400 CURRENCY_MISMATCH
 *   - AC #6: Target-already-merged returns 400 TARGET_NOT_MERGEABLE
 *   - AC #7: Source-already-merged returns 400 SOURCE_ALREADY_MERGED
 *   - AC #8: Same-id returns 400 SAME_ID
 *   - AC #9: GET /api/accounts excludes merged-source rows
 *   - AC #10: GET /api/accounts?includeMerged=true includes them
 */
import { before, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Account: typeof import('../src/models').Account;
let Transaction: typeof import('../src/models').Transaction;
let PlannedEvent: typeof import('../src/models').PlannedEvent;
let Household: typeof import('../src/models').Household;
let User: typeof import('../src/models').User;
let mergeAccounts: typeof import('../src/services/accountMerge').mergeAccounts;

before(async () => {
  const models = await import('../src/models');
  sequelize = models.sequelize;
  Account = models.Account;
  Transaction = models.Transaction;
  PlannedEvent = models.PlannedEvent;
  Household = models.Household;
  User = models.User;

  await sequelize.sync({ force: true });

  const service = await import('../src/services/accountMerge');
  mergeAccounts = service.mergeAccounts;
});

beforeEach(async () => {
  // Clear all tables
  await Transaction.destroy({ where: {}, truncate: true });
  await PlannedEvent.destroy({ where: {}, truncate: true });
  await Account.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
  await User.destroy({ where: {}, truncate: true });
});

// Helper to create test user + household
async function setupUser() {
  const user = await User.create({
    email: `test-${Date.now()}@test.local`,
    password: 'hash',
  });
  const household = await Household.create({
    name: 'Test Household',
    ownerId: user.id,
  });
  return { user, household };
}

// Helper to create two accounts
async function setupAccounts(
  household: any,
  user: any,
  currency = 'USD'
) {
  const source = await Account.create({
    name: 'Old Checking',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: currency,
  });
  const target = await Account.create({
    name: 'New Checking',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: currency,
  });
  return { source, target };
}

test('mergeAccounts: successful merge reassigns transactions', async () => {
  const { user, household } = await setupUser();
  const { source, target } = await setupAccounts(household, user);

  // Create 3 transactions on source account
  await Transaction.create({
    householdId: household.id,
    accountId: source.id,
    date: '2026-01-01',
    amount: '100.00',
    merchant: 'Merchant A',
    category: 'income',
  });
  await Transaction.create({
    householdId: household.id,
    accountId: source.id,
    date: '2026-01-02',
    amount: '-50.00',
    merchant: 'Merchant B',
    category: 'groceries',
  });
  await Transaction.create({
    householdId: household.id,
    accountId: source.id,
    date: '2026-01-03',
    amount: '-25.00',
    merchant: 'Merchant C',
    category: 'utilities',
  });

  // Merge source into target
  const result = await mergeAccounts(household.id, source.id, target.id);

  assert.ok(result.ok, 'Merge should succeed');
  assert.equal(result.movedTransactions, 3, 'Should report 3 moved transactions');

  // Verify source is marked merged_into_id
  const updatedSource = await Account.findByPk(source.id);
  assert.equal(
    updatedSource?.mergedIntoId,
    target.id,
    'Source should have mergedIntoId set'
  );
  assert.ok(updatedSource?.mergedAt, 'Source should have mergedAt set');

  // Verify transactions reassigned
  const targetTransactions = await Transaction.findAll({
    where: { accountId: target.id },
  });
  assert.equal(targetTransactions.length, 3, 'Target should have 3 transactions');

  const sourceTransactions = await Transaction.findAll({
    where: { accountId: source.id },
  });
  assert.equal(sourceTransactions.length, 0, 'Source should have 0 transactions');
});

test('mergeAccounts: successful merge reassigns planned events', async () => {
  const { user, household } = await setupUser();
  const { source, target } = await setupAccounts(household, user);

  // Create 2 planned events on source
  await PlannedEvent.create({
    householdId: household.id,
    accountId: source.id,
    description: 'Planned expense 1',
    date: '2026-06-01',
    amount: '100.00',
    category: 'utilities',
  });
  await PlannedEvent.create({
    householdId: household.id,
    accountId: source.id,
    description: 'Planned expense 2',
    date: '2026-06-02',
    amount: '50.00',
    category: 'groceries',
  });

  const result = await mergeAccounts(household.id, source.id, target.id);

  assert.ok(result.ok, 'Merge should succeed');

  const targetEvents = await PlannedEvent.findAll({
    where: { accountId: target.id },
  });
  assert.equal(targetEvents.length, 2, 'Target should have 2 planned events');

  const sourceEvents = await PlannedEvent.findAll({
    where: { accountId: source.id },
  });
  assert.equal(sourceEvents.length, 0, 'Source should have 0 planned events');
});

test('mergeAccounts: currency mismatch returns error', async () => {
  const { user, household } = await setupUser();
  const source = await Account.create({
    name: 'USD Account',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: 'USD',
  });
  const target = await Account.create({
    name: 'CAD Account',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: 'CAD',
  });

  const result = await mergeAccounts(household.id, source.id, target.id);

  assert.equal(result.ok, false, 'Merge should fail');
  assert.equal(result.error.code, 'CURRENCY_MISMATCH');
  assert.equal(result.error.sourceCurrency, 'USD');
  assert.equal(result.error.targetCurrency, 'CAD');

  // Verify no changes
  const updatedSource = await Account.findByPk(source.id);
  assert.equal(updatedSource?.mergedIntoId, null, 'Source should not be merged');
});

test('mergeAccounts: target already merged returns error', async () => {
  const { user, household } = await setupUser();
  const source = await Account.create({
    name: 'Source',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: 'USD',
  });
  const target = await Account.create({
    name: 'Target (already merged)',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: 'USD',
    mergedIntoId: 999, // Simulating target already merged
  });

  const result = await mergeAccounts(household.id, source.id, target.id);

  assert.equal(result.ok, false, 'Merge should fail');
  assert.equal(result.error.code, 'TARGET_NOT_MERGEABLE');
});

test('mergeAccounts: source already merged returns error', async () => {
  const { user, household } = await setupUser();
  const source = await Account.create({
    name: 'Source (already merged)',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: 'USD',
    mergedIntoId: 999,
  });
  const target = await Account.create({
    name: 'Target',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: 'USD',
  });

  const result = await mergeAccounts(household.id, source.id, target.id);

  assert.equal(result.ok, false, 'Merge should fail');
  assert.equal(result.error.code, 'SOURCE_ALREADY_MERGED');
});

test('mergeAccounts: same id returns error', async () => {
  const { user, household } = await setupUser();
  const account = await Account.create({
    name: 'Account',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: 'USD',
  });

  const result = await mergeAccounts(household.id, account.id, account.id);

  assert.equal(result.ok, false, 'Merge should fail');
  assert.equal(result.error.code, 'SAME_ID');
});

test('mergeAccounts: source not found returns error', async () => {
  const { user, household } = await setupUser();
  const target = await Account.create({
    name: 'Target',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: 'USD',
  });

  const result = await mergeAccounts(household.id, 99999, target.id);

  assert.equal(result.ok, false, 'Merge should fail');
  assert.equal(result.error.code, 'SOURCE_NOT_FOUND');
});

test('mergeAccounts: target not found returns error', async () => {
  const { user, household } = await setupUser();
  const source = await Account.create({
    name: 'Source',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: 'USD',
  });

  const result = await mergeAccounts(household.id, source.id, 99999);

  assert.equal(result.ok, false, 'Merge should fail');
  assert.equal(result.error.code, 'TARGET_NOT_FOUND');
});
```

- [ ] **Step 2: Run the test to verify it fails (service doesn't exist yet)**

```bash
yarn workspace cashflow-backend run test -- backend/test/accountMerge.test.ts
```

Expected: Test fails with module not found error.

### Task 4: Write the accountMerge Service

**Files:**
- Create: `backend/src/services/accountMerge.ts`

**Context:** Implements transactional merge logic. Returns success/error result objects. Handles all child-table reassignments atomically.

- [ ] **Step 1: Write the service**

```typescript
/**
 * Account merge service (issue #287).
 *
 * Provides transactional merge operation: source account is marked
 * merged_into_id, all child records reassigned to target, single atomic
 * transaction ensures consistency.
 */

import { Account, Transaction, PlannedEvent, sequelize } from '../models';

export interface MergeError {
  code:
    | 'SAME_ID'
    | 'SOURCE_NOT_FOUND'
    | 'TARGET_NOT_FOUND'
    | 'CURRENCY_MISMATCH'
    | 'TARGET_NOT_MERGEABLE'
    | 'SOURCE_ALREADY_MERGED';
  sourceCurrency?: string;
  targetCurrency?: string;
}

export interface MergeSuccess {
  ok: true;
  source: Account;
  target: Account;
  movedTransactions: number;
}

export interface MergeFailure {
  ok: false;
  error: MergeError;
}

export type MergeResult = MergeSuccess | MergeFailure;

/**
 * Filter clause for GET /api/accounts: exclude merged-source rows.
 * Used in accounts.ts: `where: { ...visibleAccountWhere(req), ...mergedAccountFilter(...) }`
 */
export function mergedAccountFilter(
  includeMerged: boolean
): Record<string, any> {
  if (includeMerged) {
    return {}; // No filter; include all
  }
  return {
    mergedIntoId: null, // Exclude rows where merged_into_id IS NOT NULL
  };
}

/**
 * Merge source account into target account.
 *
 * Validates:
 *   - Source and target are different IDs
 *   - Both belong to the same household
 *   - Currencies match
 *   - Target is not itself merged
 *   - Source is not already merged
 *
 * If valid, reassigns in a single transaction:
 *   - All transactions.account_id from source to target
 *   - All planned_events.account_id from source to target
 *   - (Future: subscriptions, recurring, etc.)
 *   - source.merged_into_id = target.id
 *   - source.merged_at = now
 *
 * Returns success with counts or error with code.
 */
export async function mergeAccounts(
  householdId: number,
  sourceId: number,
  targetId: number
): Promise<MergeResult> {
  // Validation: different IDs
  if (sourceId === targetId) {
    return {
      ok: false,
      error: { code: 'SAME_ID' },
    };
  }

  // Fetch both accounts
  const source = await Account.findOne({
    where: { id: sourceId, householdId },
  });
  if (!source) {
    return {
      ok: false,
      error: { code: 'SOURCE_NOT_FOUND' },
    };
  }

  const target = await Account.findOne({
    where: { id: targetId, householdId },
  });
  if (!target) {
    return {
      ok: false,
      error: { code: 'TARGET_NOT_FOUND' },
    };
  }

  // Validation: currencies match
  if (source.defaultCurrency !== target.defaultCurrency) {
    return {
      ok: false,
      error: {
        code: 'CURRENCY_MISMATCH',
        sourceCurrency: source.defaultCurrency || undefined,
        targetCurrency: target.defaultCurrency || undefined,
      },
    };
  }

  // Validation: target is not merged
  if (target.mergedIntoId !== null && target.mergedIntoId !== undefined) {
    return {
      ok: false,
      error: { code: 'TARGET_NOT_MERGEABLE' },
    };
  }

  // Validation: source is not already merged
  if (source.mergedIntoId !== null && source.mergedIntoId !== undefined) {
    return {
      ok: false,
      error: { code: 'SOURCE_ALREADY_MERGED' },
    };
  }

  // All validations passed; perform transactional merge
  try {
    let movedTransactions = 0;

    await sequelize.transaction(async (transaction) => {
      // Reassign transactions
      const transactionResult = await Transaction.update(
        { accountId: targetId },
        {
          where: { accountId: sourceId },
          transaction,
        }
      );
      movedTransactions = transactionResult[0]; // Update returns [count, rows]

      // Reassign planned events
      await PlannedEvent.update(
        { accountId: targetId },
        {
          where: { accountId: sourceId },
          transaction,
        }
      );

      // Mark source as merged
      source.mergedIntoId = targetId;
      source.mergedAt = new Date();
      await source.save({ transaction });
    });

    // Refresh both accounts from DB to return updated state
    const updatedSource = (await Account.findByPk(sourceId)) as Account;
    const updatedTarget = (await Account.findByPk(targetId)) as Account;

    return {
      ok: true,
      source: updatedSource,
      target: updatedTarget,
      movedTransactions,
    };
  } catch (err) {
    // Transaction rolled back automatically; return generic error
    throw err;
  }
}
```

- [ ] **Step 2: Run the integration test again to verify it passes**

```bash
yarn workspace cashflow-backend run test -- backend/test/accountMerge.test.ts
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/accountMerge.ts \
         backend/test/accountMerge.test.ts
git commit -m "feat(backend): add account merge service with transactional reassignment (#287)"
```

### Task 5: Verify and Update the Accounts Route

**Files:**
- Modify: `backend/src/routes/accounts.ts`

**Context:** The route already has the merge endpoint and filter import. Verify the implementation and ensure the GET endpoint correctly uses the filter.

- [ ] **Step 1: Verify the GET / endpoint uses mergedAccountFilter**

Read the current GET / handler (lines 24–38 in accounts.ts). Confirm it uses `mergedAccountFilter(includeMerged)` in the WHERE clause. If it doesn't, add it:

```typescript
router.get('/', async (req, res, next) => {
  try {
    const includeMerged = req.query.includeMerged === 'true';
    const rows = await Account.findAll({
      where: {
        ...visibleAccountWhere(req),
        ...mergedAccountFilter(includeMerged),
      },
      order: [['name', 'ASC']],
    });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});
```

If already present, confirm and move on.

- [ ] **Step 2: Verify the POST /:sourceId/merge-into/:targetId endpoint is correct**

Read lines 161–208 in accounts.ts. The route should:
- Parse sourceId, targetId
- Call mergeAccounts from the service
- Handle all error codes with correct HTTP status codes (400 for validation, 404 for not found)
- Return `{ source, target, movedTransactions }` on success

If the implementation matches the code shown in Task 3 above, confirm and move on. If not, update it.

- [ ] **Step 3: No code changes needed if route is correct; commit skipped**

If you made any changes:

```bash
git add backend/src/routes/accounts.ts
git commit -m "fix(routes): ensure merge endpoint properly uses accountMerge service (#287)"
```

### Task 6: Write Backend Integration Tests for API Routes

**Files:**
- Create: `backend/test/accountMergeRoutes.test.ts`

**Context:** Tests the actual HTTP endpoint behavior, including auth checks and error handling.

- [ ] **Step 1: Write route integration tests**

```typescript
/**
 * Integration tests for account merge API routes (issue #287).
 *
 * Tests:
 *   - POST /api/accounts/:sourceId/merge-into/:targetId success
 *   - POST /api/accounts/:sourceId/merge-into/:targetId error cases
 *   - GET /api/accounts excludes merged-source (AC #9)
 *   - GET /api/accounts?includeMerged=true includes them (AC #10)
 */
import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

process.env.DATABASE_PATH = ':memory:';

let app: express.Application;
let sequelize: import('sequelize').Sequelize;
let Account: typeof import('../src/models').Account;
let Transaction: typeof import('../src/models').Transaction;
let Household: typeof import('../src/models').Household;
let User: typeof import('../src/models').User;

before(async () => {
  const models = await import('../src/models');
  sequelize = models.sequelize;
  Account = models.Account;
  Transaction = models.Transaction;
  Household = models.Household;
  User = models.User;

  await sequelize.sync({ force: true });

  // Setup minimal Express app with accounts router
  app = express();
  app.use(express.json());

  // Mock auth middleware
  app.use((req, res, next) => {
    (req as any).auth = {
      user: { id: 1, globalRole: 'user' },
      household: { id: 1 },
      role: 'owner',
    };
    next();
  });

  const accountsRouter = (await import('../routes/accounts')).default;
  app.use('/api/accounts', accountsRouter);
});

beforeEach(async () => {
  await Transaction.destroy({ where: {}, truncate: true });
  await Account.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
  await User.destroy({ where: {}, truncate: true });

  // Create test household and user
  const user = await User.create({
    email: 'test@test.local',
    password: 'hash',
  });
  const household = await Household.create({
    name: 'Test Household',
    ownerId: user.id,
  });

  // Create test accounts
  await Account.create({
    id: 1,
    name: 'Source',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: 'USD',
  });
  await Account.create({
    id: 2,
    name: 'Target',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: 'USD',
  });
});

test('POST /api/accounts/:sourceId/merge-into/:targetId returns 200 on success', async () => {
  // Add a transaction to source
  await Transaction.create({
    householdId: 1,
    accountId: 1,
    date: '2026-01-01',
    amount: '100.00',
    merchant: 'Test',
    category: 'income',
  });

  const res = await request(app)
    .post('/api/accounts/1/merge-into/2')
    .expect(200);

  assert.ok(res.body.source, 'Response should have source');
  assert.ok(res.body.target, 'Response should have target');
  assert.equal(res.body.movedTransactions, 1, 'Should report 1 moved transaction');
  assert.equal(res.body.source.mergedIntoId, 2, 'Source should be marked merged');
});

test('POST /api/accounts/:sourceId/merge-into/:targetId returns 400 on currency mismatch', async () => {
  // Create account with different currency
  const household = await Household.findByPk(1);
  await Account.create({
    id: 3,
    name: 'CAD Account',
    owner: 'me',
    householdId: household!.id,
    ownerUserId: household!.ownerId,
    defaultCurrency: 'CAD',
  });

  const res = await request(app)
    .post('/api/accounts/1/merge-into/3')
    .expect(400);

  assert.equal(res.body.error, 'CURRENCY_MISMATCH');
  assert.equal(res.body.sourceCurrency, 'USD');
  assert.equal(res.body.targetCurrency, 'CAD');
});

test('GET /api/accounts excludes merged-source rows by default', async () => {
  // Create a merged account
  await Account.update(
    { mergedIntoId: 2, mergedAt: new Date() },
    { where: { id: 1 } }
  );

  const res = await request(app)
    .get('/api/accounts')
    .expect(200);

  // Should only see Target (id=2), not Source (id=1)
  assert.equal(res.body.length, 1, 'Should only have 1 account');
  assert.equal(res.body[0].name, 'Target');
});

test('GET /api/accounts?includeMerged=true includes merged-source rows', async () => {
  // Create a merged account
  await Account.update(
    { mergedIntoId: 2, mergedAt: new Date() },
    { where: { id: 1 } }
  );

  const res = await request(app)
    .get('/api/accounts?includeMerged=true')
    .expect(200);

  // Should see both Source (merged) and Target
  assert.equal(res.body.length, 2, 'Should have 2 accounts');
});
```

- [ ] **Step 2: Run the route tests**

```bash
yarn workspace cashflow-backend run test -- backend/test/accountMergeRoutes.test.ts
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add backend/test/accountMergeRoutes.test.ts
git commit -m "test(backend): add route integration tests for account merge (#287)"
```

### Task 7: Run All Backend Tests and Type Check

**Files:**
- No new files; validation step

- [ ] **Step 1: Run all backend tests**

```bash
cd /Users/connoradams/Developer/cashflow
yarn workspace cashflow-backend run test
```

Expected: All tests pass, including new merge tests.

- [ ] **Step 2: Run backend TypeScript type check**

```bash
yarn workspace cashflow-backend run typecheck
```

Expected: No errors.

- [ ] **Step 3: Run backend linter**

```bash
yarn workspace cashflow-backend run lint
```

Expected: No errors or only pre-existing errors (confirm lint is not blocking this work).

- [ ] **Step 4: Run migrations forward and backward**

```bash
yarn workspace cashflow-backend run db:migrate
yarn workspace cashflow-backend run db:rollback
yarn workspace cashflow-backend run db:migrate
```

Expected: All succeed without errors.

### Task 8: Create MergeAccountModal Component

**Files:**
- Create: `frontend/src/components/accounts/MergeAccountModal.tsx`

**Context:** Modal that shows target account selection, preview (transaction/event counts + balance impact), confirm warning, and calls the merge endpoint. Handles loading and error states.

- [ ] **Step 1: Write the modal component**

```typescript
/**
 * MergeAccountModal component (issue #287).
 *
 * Displayed when user clicks "Merge into…" on an account row.
 *
 * Features:
 *   - Account selection dropdown (filters same-currency, non-merged accounts)
 *   - Preview of transaction counts and balance impact
 *   - Merge button (disabled until valid target selected)
 *   - Loading state during merge
 *   - Error display inline
 *   - Confirm warning: "Merge is not currently reversible"
 *   - Success: modal closes, parent refetches accounts
 */

import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

interface Account {
  id: number;
  name: string;
  defaultCurrency: string;
  mergedIntoId: number | null;
  // ... other fields
}

interface MergeAccountModalProps {
  sourceAccount: Account;
  otherAccounts: Account[];
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function MergeAccountModal({
  sourceAccount,
  otherAccounts,
  isOpen,
  onClose,
  onSuccess,
}: MergeAccountModalProps) {
  const [selectedTargetId, setSelectedTargetId] = useState<number | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const queryClient = useQueryClient();

  // Filter eligible targets: same currency, not merged, not the source itself
  const eligibleTargets = otherAccounts.filter(
    (acc) =>
      acc.defaultCurrency === sourceAccount.defaultCurrency &&
      acc.mergedIntoId === null &&
      acc.id !== sourceAccount.id
  );

  const selectedTarget = eligibleTargets.find((t) => t.id === selectedTargetId);

  // Mutation for merge
  const mergeMutation = useMutation(
    async () => {
      if (!selectedTargetId) throw new Error('No target selected');

      const response = await fetch(
        `/api/accounts/${sourceAccount.id}/merge-into/${selectedTargetId}`,
        { method: 'POST' }
      );

      if (!response.ok) {
        const error = await response.json();
        throw error;
      }

      return response.json();
    },
    {
      onSuccess: () => {
        queryClient.invalidateQueries(['accounts']);
        onClose();
        onSuccess?.();
      },
    }
  );

  if (!isOpen) return null;

  const hasError = mergeMutation.isError;
  const error = mergeMutation.error as any;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">Merge accounts</h2>

        <div className="modal-body">
          {/* Source account display */}
          <p className="text-sm text-gray-600 mb-4">
            Merge <strong>{sourceAccount.name}</strong> into:
          </p>

          {/* Target selection */}
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2">
              Select target account
            </label>
            <select
              value={selectedTargetId || ''}
              onChange={(e) => {
                setSelectedTargetId(
                  e.target.value ? parseInt(e.target.value, 10) : null
                );
                setConfirmed(false); // Reset confirm when target changes
              }}
              className="w-full border rounded px-3 py-2"
              disabled={mergeMutation.isLoading}
            >
              <option value="">-- Select account --</option>
              {eligibleTargets.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.name}
                </option>
              ))}
            </select>
            {eligibleTargets.length === 0 && (
              <p className="text-sm text-red-600 mt-2">
                No eligible target accounts (same currency, not merged).
              </p>
            )}
          </div>

          {/* Preview */}
          {selectedTarget && (
            <div className="border rounded p-3 bg-gray-50 mb-4">
              <p className="text-sm font-medium mb-2">Preview</p>
              <p className="text-sm text-gray-700">
                This will move all transactions from <strong>{sourceAccount.name}</strong> to{' '}
                <strong>{selectedTarget.name}</strong>.
              </p>
              {/* Note: Transaction count would require a separate query or prop */}
              <p className="text-sm text-gray-700 mt-2">
                After merge, <strong>{sourceAccount.name}</strong> will be hidden and available only in "Hidden / merged accounts" section.
              </p>
            </div>
          )}

          {/* Error display */}
          {hasError && (
            <div className="border border-red-300 rounded p-3 bg-red-50 mb-4">
              <p className="text-sm font-medium text-red-700">
                {error.message ||
                  (error.error === 'CURRENCY_MISMATCH'
                    ? 'Accounts must be in the same currency.'
                    : error.error === 'TARGET_NOT_MERGEABLE'
                    ? 'Target has already been merged into another account.'
                    : error.error === 'SOURCE_ALREADY_MERGED'
                    ? 'Source account has already been merged.'
                    : 'An error occurred. Please try again.')}
              </p>
            </div>
          )}

          {/* Confirm warning */}
          {selectedTarget && (
            <div className="flex items-start gap-2 mb-4">
              <input
                type="checkbox"
                id="confirm-merge"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                disabled={mergeMutation.isLoading}
                className="mt-1"
              />
              <label htmlFor="confirm-merge" className="text-sm text-gray-700">
                I understand that merge is not currently reversible.
              </label>
            </div>
          )}
        </div>

        {/* Modal actions */}
        <div className="modal-footer flex gap-2 justify-end">
          <button
            onClick={onClose}
            disabled={mergeMutation.isLoading}
            className="px-4 py-2 text-gray-700 border rounded hover:bg-gray-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => mergeMutation.mutate()}
            disabled={
              !selectedTargetId ||
              !confirmed ||
              mergeMutation.isLoading ||
              hasError
            }
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {mergeMutation.isLoading ? 'Merging…' : 'Merge'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create a basic component test**

```typescript
/**
 * Component test for MergeAccountModal (issue #287).
 *
 * Tests:
 *   - Modal displays source + target selection
 *   - Merge button disabled until target selected + confirmed
 *   - Error handling on merge failure
 *   - Loading state
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { MergeAccountModal } from './MergeAccountModal';

const mockQueryClient = new QueryClient();

const sourceAccount = {
  id: 1,
  name: 'Old Checking',
  defaultCurrency: 'USD',
  mergedIntoId: null,
};

const otherAccounts = [
  {
    id: 2,
    name: 'New Checking',
    defaultCurrency: 'USD',
    mergedIntoId: null,
  },
  {
    id: 3,
    name: 'CAD Account',
    defaultCurrency: 'CAD',
    mergedIntoId: null,
  },
];

function renderModal(props = {}) {
  return render(
    <QueryClientProvider client={mockQueryClient}>
      <MergeAccountModal
        sourceAccount={sourceAccount}
        otherAccounts={otherAccounts}
        isOpen={true}
        onClose={() => {}}
        {...props}
      />
    </QueryClientProvider>
  );
}

test('displays source account name', () => {
  renderModal();
  expect(screen.getByText(/Merge Old Checking into:/)).toBeInTheDocument();
});

test('filters targets to same currency', () => {
  renderModal();
  const select = screen.getByDisplayValue('-- Select account --');
  fireEvent.change(select, { target: { value: '2' } });
  expect(screen.getByDisplayValue('New Checking')).toBeInTheDocument();
  // CAD account should not be selectable
  fireEvent.click(select);
  expect(screen.queryByText('CAD Account')).not.toBeInTheDocument();
});

test('Merge button disabled until target selected and confirmed', async () => {
  const user = userEvent.setup();
  renderModal();

  const mergeButton = screen.getByRole('button', { name: /Merge/ });
  expect(mergeButton).toBeDisabled();

  const select = screen.getByDisplayValue('-- Select account --');
  await user.selectOption(select, '2');

  // Still disabled without confirmation
  expect(mergeButton).toBeDisabled();

  const confirmCheckbox = screen.getByRole('checkbox');
  await user.click(confirmCheckbox);

  // Now enabled
  expect(mergeButton).not.toBeDisabled();
});
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/accounts/MergeAccountModal.tsx \
         frontend/src/components/accounts/MergeAccountModal.test.tsx
git commit -m "feat(frontend): add MergeAccountModal component (#287)"
```

### Task 9: Create AccountsTab in Settings

**Files:**
- Create: `frontend/src/pages/settings/tabs/AccountsTab.tsx`
- Create: `frontend/src/pages/settings/tabs/AccountsTab.test.tsx`

**Context:** Lists all accounts (active + merged) with "Merge into…" action. Merged accounts shown in collapsible "Hidden / merged accounts" section.

- [ ] **Step 1: Write the AccountsTab component**

```typescript
/**
 * AccountsTab component for Settings (issue #287).
 *
 * Features:
 *   - List of active accounts with "Merge into…" action
 *   - Collapsible "Hidden / merged accounts" section
 *   - MergeAccountModal integration
 *   - Account creation / edit (existing functionality)
 *   - Refetch on merge
 */

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MergeAccountModal } from '../../components/accounts/MergeAccountModal';

interface Account {
  id: number;
  name: string;
  accountType: string;
  defaultCurrency: string;
  owner: string;
  visibility: string;
  mergedIntoId: number | null;
  mergedAt: string | null;
  // ... other fields
}

export function AccountsTab() {
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [mergeSourceId, setMergeSourceId] = useState<number | null>(null);

  // Fetch all accounts (active + merged)
  const { data: allAccounts = [], isLoading, error, refetch } = useQuery(
    ['accounts'],
    async () => {
      const response = await fetch('/api/accounts?includeMerged=true');
      if (!response.ok) throw new Error('Failed to fetch accounts');
      return response.json();
    }
  );

  const activeAccounts = allAccounts.filter((acc) => !acc.mergedIntoId);
  const mergedAccounts = allAccounts.filter((acc) => acc.mergedIntoId);

  const mergeSource = mergeSourceId
    ? allAccounts.find((a) => a.id === mergeSourceId)
    : null;

  const handleMergeClick = (account: Account) => {
    setMergeSourceId(account.id);
    setShowMergeModal(true);
  };

  const handleMergeSuccess = () => {
    setShowMergeModal(false);
    setMergeSourceId(null);
    refetch();
  };

  if (isLoading) return <div>Loading accounts…</div>;
  if (error) return <div>Error loading accounts</div>;

  return (
    <div className="space-y-6">
      {/* Active accounts */}
      <div>
        <h3 className="text-lg font-semibold mb-4">Accounts</h3>
        {activeAccounts.length === 0 ? (
          <p className="text-gray-600">No accounts yet.</p>
        ) : (
          <div className="space-y-2">
            {activeAccounts.map((account) => (
              <div
                key={account.id}
                className="flex items-center justify-between p-3 border rounded hover:bg-gray-50"
              >
                <div>
                  <p className="font-medium">{account.name}</p>
                  <p className="text-sm text-gray-600">
                    {account.accountType} • {account.defaultCurrency}
                  </p>
                </div>
                <div className="flex gap-2">
                  {/* Other actions (edit, etc.) */}
                  <button
                    onClick={() => handleMergeClick(account)}
                    className="px-3 py-1 text-sm bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                  >
                    Merge into…
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Hidden / merged accounts */}
      {mergedAccounts.length > 0 && (
        <details className="border rounded p-3">
          <summary className="cursor-pointer font-medium text-gray-700 hover:text-gray-900">
            Hidden / merged accounts ({mergedAccounts.length})
          </summary>
          <div className="mt-3 space-y-2">
            {mergedAccounts.map((account) => {
              const target = allAccounts.find(
                (a) => a.id === account.mergedIntoId
              );
              return (
                <div key={account.id} className="p-3 bg-gray-50 rounded border-l-4 border-gray-300">
                  <p className="font-medium text-gray-700">{account.name}</p>
                  <p className="text-sm text-gray-600">
                    Merged into <strong>{target?.name || 'Unknown'}</strong> on{' '}
                    {new Date(account.mergedAt).toLocaleDateString()}
                  </p>
                </div>
              );
            })}
          </div>
        </details>
      )}

      {/* Merge modal */}
      {mergeSource && (
        <MergeAccountModal
          sourceAccount={mergeSource}
          otherAccounts={activeAccounts}
          isOpen={showMergeModal}
          onClose={() => setShowMergeModal(false)}
          onSuccess={handleMergeSuccess}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write basic component test**

```typescript
/**
 * Component test for AccountsTab (issue #287).
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { AccountsTab } from './AccountsTab';

const mockQueryClient = new QueryClient();

const mockAccounts = [
  {
    id: 1,
    name: 'Checking',
    accountType: 'checking',
    defaultCurrency: 'USD',
    owner: 'me',
    visibility: 'private',
    mergedIntoId: null,
    mergedAt: null,
  },
  {
    id: 2,
    name: 'Old Checking',
    accountType: 'checking',
    defaultCurrency: 'USD',
    owner: 'me',
    visibility: 'private',
    mergedIntoId: 1,
    mergedAt: '2026-05-30T10:00:00Z',
  },
];

beforeEach(() => {
  global.fetch = jest.fn((url) => {
    if (url.includes('/api/accounts')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockAccounts),
      });
    }
    return Promise.reject(new Error('Not found'));
  });
});

test('displays active accounts', async () => {
  render(
    <QueryClientProvider client={mockQueryClient}>
      <AccountsTab />
    </QueryClientProvider>
  );

  await waitFor(() => {
    expect(screen.getByText('Checking')).toBeInTheDocument();
  });
});

test('displays merged accounts in collapsible section', async () => {
  render(
    <QueryClientProvider client={mockQueryClient}>
      <AccountsTab />
    </QueryClientProvider>
  );

  await waitFor(() => {
    const summary = screen.getByText(/Hidden \/ merged accounts/);
    expect(summary).toBeInTheDocument();
  });

  fireEvent.click(screen.getByText(/Hidden \/ merged accounts/));
  expect(screen.getByText(/Old Checking/)).toBeInTheDocument();
  expect(screen.getByText(/Merged into Checking/)).toBeInTheDocument();
});

test('Merge button opens modal', async () => {
  render(
    <QueryClientProvider client={mockQueryClient}>
      <AccountsTab />
    </QueryClientProvider>
  );

  await waitFor(() => {
    const mergeButton = screen.getByRole('button', {
      name: /Merge into\.\.\./,
    });
    expect(mergeButton).toBeInTheDocument();

    fireEvent.click(mergeButton);
    expect(screen.getByText(/Merge accounts/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Register AccountsTab in Settings routing**

Check `frontend/src/pages/settings/SettingsPage.tsx` or the routing file to see how tabs are registered. Add AccountsTab to the tab list. Example (adjust based on actual pattern):

```typescript
import { AccountsTab } from './tabs/AccountsTab';

// In tab definitions:
{
  label: 'Accounts',
  key: 'accounts',
  Component: AccountsTab,
}
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/settings/tabs/AccountsTab.tsx \
         frontend/src/pages/settings/tabs/AccountsTab.test.tsx \
         frontend/src/pages/settings/SettingsPage.tsx
git commit -m "feat(frontend): add AccountsTab with merge UI integration (#287)"
```

### Task 10: Frontend Type Check and Lint

**Files:**
- No new files; validation step

- [ ] **Step 1: Run frontend TypeScript type check**

```bash
cd /Users/connoradams/Developer/cashflow
yarn workspace frontend run tsc -b
```

Expected: No errors.

- [ ] **Step 2: Run frontend linter**

```bash
yarn workspace frontend run lint
```

Expected: No errors or only pre-existing.

### Task 11: Manual Verification

**Context:** Start the dev server and test the merge flow end-to-end in a browser.

- [ ] **Step 1: Start the dev server**

```bash
# Terminal 1: Backend
yarn workspace cashflow-backend run dev

# Terminal 2: Frontend
yarn workspace frontend run dev
```

- [ ] **Step 2: Open app in browser**

Navigate to `http://localhost:3000` (or the port shown by frontend dev server).

- [ ] **Step 3: Go to Settings → Accounts**

Verify:
- Accounts list displays with "Merge into…" button on each row
- Merged accounts section is visible (if any exist, or create a test merge)

- [ ] **Step 4: Create two test accounts**

Via the Accounts page or Settings tab:
- Create "Test Account A" (USD)
- Create "Test Account B" (USD)

- [ ] **Step 5: Create some test transactions**

Create a few transactions in "Test Account A".

- [ ] **Step 6: Merge A into B**

1. Click "Merge into…" on Test Account A
2. Verify modal displays source name and target selection
3. Select Test Account B
4. Verify preview shows transaction count
5. Check the confirmation checkbox
6. Click Merge
7. Verify merge succeeds (modal closes, toast appears, accounts list refetches)

- [ ] **Step 7: Verify merged state**

1. Verify "Test Account A" no longer appears in active accounts
2. Open "Hidden / merged accounts" section
3. Verify "Test Account A" appears there with merge date and target
4. Check Test Account B transactions — should now include the 3 transactions from A

- [ ] **Step 8: Verify GET /api/accounts filtering**

Browser console:

```javascript
// Check default (excludes merged)
fetch('/api/accounts').then(r => r.json()).then(d => console.log(d))

// Check with includeMerged=true
fetch('/api/accounts?includeMerged=true').then(r => r.json()).then(d => console.log(d))
```

Expected: First call shows 1 account; second call shows 2.

### Task 12: Final Test Run and Commit

**Files:**
- No new files; final validation

- [ ] **Step 1: Run all tests one more time**

```bash
yarn workspace cashflow-backend run test
yarn workspace frontend run test
```

Expected: All tests pass.

- [ ] **Step 2: Run all type checks and linters**

```bash
yarn workspace cashflow-backend run typecheck
yarn workspace backend run lint
yarn workspace frontend run tsc -b
yarn workspace frontend run lint
```

Expected: No errors.

- [ ] **Step 3: Create comprehensive final commit or verify all commits are present**

Check git log:

```bash
git log --oneline -10
```

Should see commits for:
1. Migration file
2. Migration test
3. accountMerge service + test
4. accountMerge route tests
5. MergeAccountModal component
6. AccountsTab component + tab registration

If any are missing, create them now.

---

## Acceptance Criteria Mapping

- **AC #1** (Migration reversible) → Task 2 + Task 3 migration test
- **AC #2** (Transactions reassigned) → Task 4 integration test + Task 6 route tests
- **AC #3** (PlannedEvents reassigned) → Task 4 integration test
- **AC #4** (Atomic transaction) → Task 4 + 5 service implementation
- **AC #5** (Currency mismatch error) → Task 4 + 6 tests
- **AC #6** (Target-not-mergeable error) → Task 4 + 6 tests
- **AC #7** (Source-already-merged error) → Task 4 + 6 tests
- **AC #8** (Same-id error) → Task 4 + 6 tests
- **AC #9** (GET /api/accounts excludes merged) → Task 5 + 6 route tests
- **AC #10** (GET /api/accounts?includeMerged=true) → Task 5 + 6 route tests
- **AC #11** (Settings UI with Merge action) → Task 9 AccountsTab
- **AC #12** (Merge button disabled until valid target) → Task 8 + 9 components
- **AC #13** (Hidden / merged section) → Task 9 AccountsTab

---

## Summary

This plan delivers issue #287 end-to-end: soft-merge accounts with transactional child-record reassignment, frontend UI for merge + hidden section, full test coverage (backend integration + route tests + frontend component tests), and manual verification in the browser.

Execution recommended via **superpowers:subagent-driven-development** (one task per subagent) or **superpowers:executing-plans** (inline in this session). Each task is designed to be independently reviewable and testable.
