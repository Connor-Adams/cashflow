# Transaction Enrichment Pipeline — Foundation + Deterministic Stages

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current ad-hoc rule + memory branching in import paths with an explicit, staged enrichment pipeline that produces typed `Signal` outputs, persists them to a `transaction_signals` table, and computes `review_flag` from signal confidence instead of always-true.

**Architecture:** A single orchestrator (`backend/src/import/enrich.ts`) calls 8 deterministic stages in fixed order, each producing 0–N typed `Signal[]`. Signals are merged by an explicit precedence ladder; the winning fields populate `auto_*` columns on the transaction and a `transaction_signals` child table records each signal for transparency. Both `runImport.ts` (CSV upload) and `commitStatementImport.ts` (statement preview/commit) are migrated to call the orchestrator. AI inline (`ai-batch` stage) is deferred to Plan 2.

**Tech Stack:** TypeScript, Sequelize 6 (SQLite dev / Postgres prod), node:test runner via `tsx`, existing `findBestRule` / `findMerchantMemory` / `scoreAmazonOrderMatch` helpers kept and wrapped by stages.

**Spec:** [`docs/superpowers/specs/2026-05-20-transaction-enrichment-design.md`](../specs/2026-05-20-transaction-enrichment-design.md)

---

## File Structure

### New files

- `backend/src/migrations/20260520000002-transaction-enrichment.js` — adds 6 columns to `transactions` and creates `transaction_signals`.
- `backend/src/models/TransactionSignal.ts` — Sequelize model for `transaction_signals`.
- `backend/src/import/enrichment/types.ts` — `Confidence`, `SignalSource`, `TxnType`, `Signal`, `EnrichmentContext`, `EnrichmentResult`.
- `backend/src/import/enrichment/brandDictionary.ts` — seed list + learned-from-memory helpers.
- `backend/src/import/enrichment/normalizeStage.ts` — stage 1: real merchant normalisation + canonical brand lookup.
- `backend/src/import/enrichment/detectTypeStage.ts` — stage 2: `txnType` from narrative + sign.
- `backend/src/import/enrichment/detectRecurringStage.ts` — stage 3.
- `backend/src/import/enrichment/applyRuleStage.ts` — stage 4: wraps existing `findBestRule`.
- `backend/src/import/enrichment/merchantMemoryStage.ts` — stage 5: wraps existing `findMerchantMemory`.
- `backend/src/import/enrichment/linkItemsStage.ts` — stage 6: pulls `scoreAmazonOrderMatch` inline.
- `backend/src/import/enrichment/detectRelationshipsStage.ts` — stage 7: refund-link + transfer-link.
- `backend/src/import/enrichment/computeReviewFlag.ts` — stage 9: precedence merge + review_flag.
- `backend/src/import/enrich.ts` — public orchestrator: `enrichTransaction(raw, ctx)`.
- `backend/test/normalizeMerchant.test.ts`
- `backend/test/brandDictionary.test.ts`
- `backend/test/enrichDetectType.test.ts`
- `backend/test/enrichDetectRecurring.test.ts`
- `backend/test/enrichApplyRule.test.ts`
- `backend/test/enrichMerchantMemory.test.ts`
- `backend/test/enrichLinkItems.test.ts`
- `backend/test/enrichDetectRelationships.test.ts`
- `backend/test/enrichComputeReviewFlag.test.ts`
- `backend/test/enrichPipeline.test.ts` — end-to-end orchestrator tests.

### Modified files

- `backend/src/import/normalizeMerchant.ts` — replace trivial trim-only impl with real normaliser. Existing callers (`mapRow.ts`, `parseStatementFile.ts`) keep same import path.
- `backend/src/models/Transaction.ts` — add 6 new declared fields.
- `backend/src/models/index.ts` — register `TransactionSignal` + association.
- `backend/src/config/env.ts` — add new enrichment env vars.
- `backend/src/import/runImport.ts` — replace lines 250-298 inline rule/memory with `enrichTransaction(v, ctx)` + signal persistence.
- `backend/src/import/commitStatementImport.ts` — same migration at lines ~204-220.

### Files NOT touched

- `backend/src/import/applyRules.ts` — kept; `applyRuleStage` wraps `findBestRule`.
- `backend/src/ai/merchantMemory.ts` — kept; `merchantMemoryStage` wraps `findMerchantMemory`.
- `backend/src/ai/suggestTransaction.ts` — keeps using `findBestRule` and `findMerchantMemory` directly; not part of this plan.
- `backend/src/amazon/matcher.ts` — kept; `linkItemsStage` wraps `scoreAmazonOrderMatch`.

---

## Conventions

- **Test runner:** all tests use `node:test` with `import { test } from 'node:test'` and `import assert from 'node:assert/strict'`, matching existing `backend/test/*.test.ts`.
- **Run a single test file:** `cd backend && yarn tsx --test test/<file>.test.ts`
- **Run all backend tests:** `cd backend && yarn test`
- **Typecheck:** `cd backend && yarn typecheck`
- **Migrate (sqlite dev DB):** `cd backend && yarn db:migrate` / `yarn db:migrate:undo`
- **Commits:** prefix `feat(enrichment):` or `chore(enrichment):` or `refactor(enrichment):`. Never include co-author lines.

---

## Task 1: Migration — add enrichment columns and `transaction_signals` table

**Files:**
- Create: `backend/src/migrations/20260520000002-transaction-enrichment.js`

- [ ] **Step 1: Write the migration**

Create `backend/src/migrations/20260520000002-transaction-enrichment.js`:

```js
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('transactions', 'merchant_canonical', {
      type: Sequelize.STRING(256),
      allowNull: true,
    });
    await queryInterface.addColumn('transactions', 'txn_type', {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'purchase',
    });
    await queryInterface.addColumn('transactions', 'auto_source', {
      type: Sequelize.STRING(32),
      allowNull: true,
    });
    await queryInterface.addColumn('transactions', 'auto_confidence', {
      type: Sequelize.STRING(8),
      allowNull: true,
    });
    await queryInterface.addColumn('transactions', 'linked_transaction_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'transactions', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await queryInterface.addColumn('transactions', 'is_recurring', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addIndex('transactions', ['linked_transaction_id'], {
      name: 'transactions_linked_transaction_id',
    });
    await queryInterface.addIndex('transactions', ['merchant_canonical'], {
      name: 'transactions_merchant_canonical',
    });

    await queryInterface.createTable('transaction_signals', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      transaction_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'transactions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      source: { type: Sequelize.STRING(32), allowNull: false },
      confidence: { type: Sequelize.STRING(8), allowNull: false },
      fields: { type: Sequelize.JSON, allowNull: false },
      rationale: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('transaction_signals', ['transaction_id'], {
      name: 'transaction_signals_transaction_id',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'transaction_signals',
      'transaction_signals_transaction_id'
    );
    await queryInterface.dropTable('transaction_signals');
    await queryInterface.removeIndex(
      'transactions',
      'transactions_merchant_canonical'
    );
    await queryInterface.removeIndex(
      'transactions',
      'transactions_linked_transaction_id'
    );
    await queryInterface.removeColumn('transactions', 'is_recurring');
    await queryInterface.removeColumn('transactions', 'linked_transaction_id');
    await queryInterface.removeColumn('transactions', 'auto_confidence');
    await queryInterface.removeColumn('transactions', 'auto_source');
    await queryInterface.removeColumn('transactions', 'txn_type');
    await queryInterface.removeColumn('transactions', 'merchant_canonical');
  },
};
```

- [ ] **Step 2: Run forward migration**

Run: `cd backend && yarn db:migrate`
Expected: output includes `20260520000002-transaction-enrichment: migrated` with no error.

- [ ] **Step 3: Run rollback to verify down()**

Run: `cd backend && yarn db:migrate:undo`
Expected: output includes `20260520000002-transaction-enrichment: reverted`. No error.

- [ ] **Step 4: Re-apply forward migration**

Run: `cd backend && yarn db:migrate`
Expected: migrated again. No error.

- [ ] **Step 5: Commit**

```bash
GH_PACKAGES_TOKEN="" git add backend/src/migrations/20260520000002-transaction-enrichment.js && \
GH_PACKAGES_TOKEN="" git commit -m "feat(enrichment): add transaction enrichment columns and signals table"
```

---

## Task 2: Add new fields to Transaction model

**Files:**
- Modify: `backend/src/models/Transaction.ts`

- [ ] **Step 1: Add declared fields**

In `backend/src/models/Transaction.ts`, add the six new declarations inside the `Transaction` class, after the existing `appliedRuleId` declaration (line 32):

```ts
  declare merchantCanonical: string | null;
  declare txnType: CreationOptional<string>;
  declare autoSource: string | null;
  declare autoConfidence: string | null;
  declare linkedTransactionId: number | null;
  declare isRecurring: CreationOptional<boolean>;
```

- [ ] **Step 2: Add init definitions**

In the same file, inside the `Transaction.init({...})` call, add the six new attribute definitions immediately before the `reviewFlag` block (around line 239):

```ts
      merchantCanonical: {
        type: DataTypes.STRING(256),
        field: 'merchant_canonical',
        allowNull: true,
      },
      txnType: {
        type: DataTypes.STRING(16),
        field: 'txn_type',
        allowNull: false,
        defaultValue: 'purchase',
      },
      autoSource: {
        type: DataTypes.STRING(32),
        field: 'auto_source',
        allowNull: true,
      },
      autoConfidence: {
        type: DataTypes.STRING(8),
        field: 'auto_confidence',
        allowNull: true,
      },
      linkedTransactionId: {
        type: DataTypes.INTEGER,
        field: 'linked_transaction_id',
        allowNull: true,
      },
      isRecurring: {
        type: DataTypes.BOOLEAN,
        field: 'is_recurring',
        allowNull: false,
        defaultValue: false,
      },
```

- [ ] **Step 3: Run typecheck**

Run: `cd backend && yarn typecheck`
Expected: no errors.

- [ ] **Step 4: Run full backend test suite**

Run: `cd backend && yarn test`
Expected: all tests pass (no behaviour change yet).

- [ ] **Step 5: Commit**

```bash
GH_PACKAGES_TOKEN="" git add backend/src/models/Transaction.ts && \
GH_PACKAGES_TOKEN="" git commit -m "feat(enrichment): add enrichment fields to Transaction model"
```

---

## Task 3: Create TransactionSignal model

**Files:**
- Create: `backend/src/models/TransactionSignal.ts`
- Modify: `backend/src/models/index.ts`

- [ ] **Step 1: Create the model file**

Create `backend/src/models/TransactionSignal.ts`:

```ts
import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class TransactionSignal extends Model<
  InferAttributes<TransactionSignal>,
  InferCreationAttributes<TransactionSignal>
> {
  declare id: CreationOptional<number>;
  declare transactionId: number;
  declare source: string;
  declare confidence: string;
  declare fields: Record<string, unknown>;
  declare rationale: string | null;
  declare readonly createdAt: CreationOptional<Date>;
}

export function initTransactionSignal(
  sequelize: Sequelize,
): typeof TransactionSignal {
  TransactionSignal.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      transactionId: {
        type: DataTypes.INTEGER,
        field: 'transaction_id',
        allowNull: false,
      },
      source: { type: DataTypes.STRING(32), allowNull: false },
      confidence: { type: DataTypes.STRING(8), allowNull: false },
      fields: { type: DataTypes.JSON, allowNull: false },
      rationale: { type: DataTypes.TEXT, allowNull: true },
    } as ModelAttributes<TransactionSignal>,
    {
      sequelize,
      modelName: 'TransactionSignal',
      tableName: 'transaction_signals',
      underscored: true,
      timestamps: true,
    },
  );
  return TransactionSignal;
}
```

- [ ] **Step 2: Register in models/index.ts**

In `backend/src/models/index.ts`:

Add to the imports block (after the `TransactionOrderLink` import line):

```ts
import { TransactionSignal, initTransactionSignal } from './TransactionSignal';
```

Add to the init block (after `initTransactionOrderLink(sequelize);`):

```ts
initTransactionSignal(sequelize);
```

Add to the associations block (after the last existing `TransactionOrderLink` association):

```ts
Transaction.hasMany(TransactionSignal, {
  foreignKey: 'transaction_id',
  as: 'enrichmentSignals',
});
TransactionSignal.belongsTo(Transaction, {
  foreignKey: 'transaction_id',
  as: 'transaction',
});
```

Add to the `export { ... }` block:

```ts
  TransactionSignal,
```

- [ ] **Step 3: Run typecheck**

Run: `cd backend && yarn typecheck`
Expected: no errors.

- [ ] **Step 4: Run tests**

Run: `cd backend && yarn test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
GH_PACKAGES_TOKEN="" git add backend/src/models/TransactionSignal.ts backend/src/models/index.ts && \
GH_PACKAGES_TOKEN="" git commit -m "feat(enrichment): add TransactionSignal model and association"
```

---

## Task 4: Add enrichment env vars

**Files:**
- Modify: `backend/src/config/env.ts`

- [ ] **Step 1: Read current env.ts structure**

Run: `cd backend && head -80 src/config/env.ts`

Note the existing pattern for reading env vars (likely `process.env.X ?? default`).

- [ ] **Step 2: Append enrichment vars at end of `env.ts` exports**

In `backend/src/config/env.ts`, append (matching the existing style):

```ts
function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const enrichmentRecurringMinSupport = parseIntEnv(
  'ENRICHMENT_RECURRING_MIN_SUPPORT',
  3,
);
export const enrichmentAmazonLinkThreshold = parseIntEnv(
  'ENRICHMENT_AMAZON_LINK_THRESHOLD',
  70,
);
export const enrichmentRefundWindowDays = parseIntEnv(
  'ENRICHMENT_REFUND_WINDOW_DAYS',
  60,
);
export const enrichmentTransferWindowDays = parseIntEnv(
  'ENRICHMENT_TRANSFER_WINDOW_DAYS',
  2,
);
```

If `parseIntEnv` already exists in the file, reuse it — do not define twice.

- [ ] **Step 3: Run typecheck**

Run: `cd backend && yarn typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
GH_PACKAGES_TOKEN="" git add backend/src/config/env.ts && \
GH_PACKAGES_TOKEN="" git commit -m "feat(enrichment): add enrichment configuration env vars"
```

---

## Task 5: Create enrichment types module

**Files:**
- Create: `backend/src/import/enrichment/types.ts`

- [ ] **Step 1: Create the types file**

Create `backend/src/import/enrichment/types.ts`:

```ts
import type { Account } from '../../models/Account';
import type { ExternalOrder } from '../../models/ExternalOrder';
import type { ExternalOrderItem } from '../../models/ExternalOrderItem';
import type { RuleRow } from '../applyRules';

export type Confidence = 'high' | 'medium' | 'low';

export type SignalSource =
  | 'normalize-seed'
  | 'normalize-learned'
  | 'type-detect'
  | 'recurring'
  | 'rule'
  | 'memory'
  | 'amazon-items'
  | 'refund-link'
  | 'transfer-link'
  | 'ai';

export type TxnType =
  | 'purchase'
  | 'refund'
  | 'transfer'
  | 'payment'
  | 'fee'
  | 'interest'
  | 'reward'
  | 'unknown';

export type SignalFields = Partial<{
  merchantClean: string;
  merchantCanonical: string | null;
  txnType: TxnType;
  autoCategory: string | null;
  autoBusiness: boolean | null;
  autoSplitType: string | null;
  autoPctMe: string | null;
  autoPctPartner: string | null;
  appliedRuleId: number | null;
  linkedTransactionId: number | null;
  linkedExternalOrderId: number | null;
  isRecurring: boolean;
  notes: string | null;
}>;

export interface Signal {
  source: SignalSource;
  confidence: Confidence;
  fields: SignalFields;
  rationale?: string;
}

export interface PendingEnrichedTxn {
  date: string;
  merchantRaw: string;
  merchantClean: string;
  merchantCanonical: string | null;
  amount: number;
  currency: string;
  txnType: TxnType;
  signals: Signal[];
  /** id once saved; null while still in-flight */
  savedId: number | null;
}

export interface EnrichmentContext {
  account: Account;
  householdId: number | null;
  rulesCache: RuleRow[];
  amazonOrdersCache: Array<ExternalOrder & { items?: ExternalOrderItem[] }>;
  /** Rows already processed in this import (saved or deferred). Used for refund/transfer linking. */
  inFlightBatch: PendingEnrichedTxn[];
}

export interface EnrichmentResultFields {
  merchantClean: string;
  merchantCanonical: string | null;
  txnType: TxnType;
  autoCategory: string | null;
  autoBusiness: boolean | null;
  autoSplitType: string | null;
  autoPctMe: string | null;
  autoPctPartner: string | null;
  appliedRuleId: number | null;
  linkedTransactionId: number | null;
  isRecurring: boolean;
  notes: string | null;
  autoSource: SignalSource | 'composite' | null;
  autoConfidence: Confidence | null;
  reviewFlag: boolean;
}

export interface EnrichmentResult {
  fields: EnrichmentResultFields;
  signals: Signal[];
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd backend && yarn typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
GH_PACKAGES_TOKEN="" git add backend/src/import/enrichment/types.ts && \
GH_PACKAGES_TOKEN="" git commit -m "feat(enrichment): add core enrichment types"
```

---

## Task 6: Brand dictionary — seed list + tests

**Files:**
- Create: `backend/src/import/enrichment/brandDictionary.ts`
- Create: `backend/test/brandDictionary.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/test/brandDictionary.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lookupSeedBrand,
  type BrandEntry,
} from '../src/import/enrichment/brandDictionary';

test('lookupSeedBrand returns Amazon for AMZN MKTP variants', () => {
  assert.equal(lookupSeedBrand('AMZN MKTP US A1B2C3'), 'Amazon');
  assert.equal(lookupSeedBrand('amazon.ca prime'), 'Amazon');
  assert.equal(lookupSeedBrand('AMZN Digital Svcs'), 'Amazon');
});

test('lookupSeedBrand returns Netflix for Netflix variants', () => {
  assert.equal(lookupSeedBrand('NETFLIX.COM'), 'Netflix');
  assert.equal(lookupSeedBrand('netflix monthly'), 'Netflix');
});

test('lookupSeedBrand returns null for unknown', () => {
  assert.equal(lookupSeedBrand("Joe's Coffee Shop"), null);
  assert.equal(lookupSeedBrand(''), null);
});

test('lookupSeedBrand normalizes case', () => {
  assert.equal(lookupSeedBrand('SPOTIFY'), 'Spotify');
  assert.equal(lookupSeedBrand('spotify usa'), 'Spotify');
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `cd backend && yarn tsx --test test/brandDictionary.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement brand dictionary**

Create `backend/src/import/enrichment/brandDictionary.ts`:

```ts
export interface BrandEntry {
  pattern: RegExp;
  canonical: string;
}

const SEED_BRANDS: BrandEntry[] = [
  { pattern: /\b(amazon(?:\.(?:com|ca|co\.uk))?|amzn|amzn\s*mktp|amzn\s*digital)\b/i, canonical: 'Amazon' },
  { pattern: /\b(netflix)\b/i, canonical: 'Netflix' },
  { pattern: /\b(spotify)\b/i, canonical: 'Spotify' },
  { pattern: /\b(apple\.com|itunes|apple\s*music|apple\s*tv|apple\s*store)\b/i, canonical: 'Apple' },
  { pattern: /\b(google\s*\*|google\s*play|google\s*storage|google\s*one|youtube\s*premium|googlepay)\b/i, canonical: 'Google' },
  { pattern: /\b(uber(?:\s*eats)?|uber\.com)\b/i, canonical: 'Uber' },
  { pattern: /\b(lyft)\b/i, canonical: 'Lyft' },
  { pattern: /\b(doordash|dd\s*\*doordash)\b/i, canonical: 'DoorDash' },
  { pattern: /\b(starbucks|sbux)\b/i, canonical: 'Starbucks' },
  { pattern: /\b(mcdonalds|mcdonald's|mcd\s*\d*)\b/i, canonical: "McDonald's" },
  { pattern: /\b(costco(?:\s*whse)?)\b/i, canonical: 'Costco' },
  { pattern: /\b(walmart|wal-mart|wm\s*supercenter)\b/i, canonical: 'Walmart' },
  { pattern: /\b(target\.com|target\s*\d*)\b/i, canonical: 'Target' },
  { pattern: /\b(shell\s*oil|shell\s*\d|shell\s*canada)\b/i, canonical: 'Shell' },
  { pattern: /\b(esso)\b/i, canonical: 'Esso' },
  { pattern: /\b(petro-canada|petro\s*can)\b/i, canonical: 'Petro-Canada' },
  { pattern: /\b(loblaws|loblaw|nofrills|no\s*frills)\b/i, canonical: 'Loblaws' },
  { pattern: /\b(metro\s*ontario|metro\s*store)\b/i, canonical: 'Metro' },
  { pattern: /\b(sobeys)\b/i, canonical: 'Sobeys' },
  { pattern: /\b(tim\s*hortons|tim\s*horton)\b/i, canonical: 'Tim Hortons' },
  { pattern: /\b(rogers\s*comm|rogers\s*wireless)\b/i, canonical: 'Rogers' },
  { pattern: /\b(bell\s*canada|bell\s*mobility|bell\s*mts)\b/i, canonical: 'Bell' },
  { pattern: /\b(telus|telus\s*mobility)\b/i, canonical: 'Telus' },
  { pattern: /\b(hydro\s*one|toronto\s*hydro|bc\s*hydro)\b/i, canonical: 'Hydro' },
  { pattern: /\b(enbridge)\b/i, canonical: 'Enbridge' },
  { pattern: /\b(disney\s*plus|disneyplus|disney\s*\+)\b/i, canonical: 'Disney+' },
  { pattern: /\b(github|gh\s*\*github)\b/i, canonical: 'GitHub' },
  { pattern: /\b(openai|chatgpt)\b/i, canonical: 'OpenAI' },
  { pattern: /\b(anthropic|claude\.ai)\b/i, canonical: 'Anthropic' },
  { pattern: /\b(stripe\s*\*|stripe\.com)\b/i, canonical: 'Stripe' },
  { pattern: /\b(paypal\s*\*)\b/i, canonical: 'PayPal' },
  { pattern: /\b(square\s*\*|sq\s*\*)\b/i, canonical: 'Square' },
];

export function lookupSeedBrand(merchantClean: string): string | null {
  if (!merchantClean) return null;
  for (const entry of SEED_BRANDS) {
    if (entry.pattern.test(merchantClean)) return entry.canonical;
  }
  return null;
}

export function getSeedBrandList(): readonly BrandEntry[] {
  return SEED_BRANDS;
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd backend && yarn tsx --test test/brandDictionary.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
GH_PACKAGES_TOKEN="" git add backend/src/import/enrichment/brandDictionary.ts backend/test/brandDictionary.test.ts && \
GH_PACKAGES_TOKEN="" git commit -m "feat(enrichment): seed brand dictionary with lookup helpers"
```

---

## Task 7: Real `normalizeMerchant` with golden tests

**Files:**
- Modify: `backend/src/import/normalizeMerchant.ts`
- Create: `backend/test/normalizeMerchant.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/test/normalizeMerchant.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMerchant } from '../src/import/normalizeMerchant';

test('normalizeMerchant trims and collapses whitespace', () => {
  assert.equal(normalizeMerchant('  Foo   Bar  '), 'Foo Bar');
});

test('normalizeMerchant strips SQ * processor prefix', () => {
  assert.equal(normalizeMerchant('SQ *JOES COFFEE'), 'JOES COFFEE');
  assert.equal(normalizeMerchant('SQ *JOE&#39;S COFFEE TORONTO'), "JOE'S COFFEE TORONTO");
});

test('normalizeMerchant strips TST* prefix', () => {
  assert.equal(normalizeMerchant('TST*LOCAL BISTRO'), 'LOCAL BISTRO');
});

test('normalizeMerchant strips PAYPAL * prefix', () => {
  assert.equal(normalizeMerchant('PAYPAL *MERCHANT123'), 'MERCHANT123');
});

test('normalizeMerchant strips AMZN MKTP US* trailing identifier', () => {
  assert.equal(normalizeMerchant('AMZN MKTP US*A1B2C3D4'), 'AMZN MKTP US');
  assert.equal(normalizeMerchant('AMZN Mktp US*Z9Y8X7'), 'AMZN Mktp US');
});

test('normalizeMerchant strips STRIPE* and GOOGLE *', () => {
  assert.equal(normalizeMerchant('STRIPE*MERCHANT'), 'MERCHANT');
  assert.equal(normalizeMerchant('GOOGLE *DOMAINS'), 'DOMAINS');
});

test('normalizeMerchant strips trailing store/transit numbers', () => {
  assert.equal(normalizeMerchant('STARBUCKS #1234'), 'STARBUCKS');
  assert.equal(normalizeMerchant('TARGET STORE 5678'), 'TARGET');
  assert.equal(normalizeMerchant('SHELL OIL 91234'), 'SHELL OIL');
});

test('normalizeMerchant strips trailing US/CA city-state tails', () => {
  assert.equal(normalizeMerchant('JOE COFFEE TORONTO ON'), 'JOE COFFEE');
  assert.equal(normalizeMerchant('CAFE BAR NEW YORK NY US'), 'CAFE BAR');
  assert.equal(normalizeMerchant('SAM SHOP MISSISSAUGA ON CA'), 'SAM SHOP');
});

test('normalizeMerchant strips trailing phone numbers', () => {
  assert.equal(normalizeMerchant('PIZZA SHOP 416-555-1212'), 'PIZZA SHOP');
  assert.equal(normalizeMerchant('STORE 800.555.0199'), 'STORE');
});

test('normalizeMerchant is idempotent', () => {
  const once = normalizeMerchant('SQ *JOE COFFEE TORONTO ON #1234');
  const twice = normalizeMerchant(once);
  assert.equal(once, twice);
});

test('normalizeMerchant handles empty / non-string input', () => {
  assert.equal(normalizeMerchant(''), '');
  assert.equal(normalizeMerchant(null), '');
  assert.equal(normalizeMerchant(undefined), '');
});

test('normalizeMerchant leaves recognised cleaned merchants untouched', () => {
  assert.equal(normalizeMerchant('NETFLIX.COM'), 'NETFLIX.COM');
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `cd backend && yarn tsx --test test/normalizeMerchant.test.ts`
Expected: most tests FAIL (current impl only trims).

- [ ] **Step 3: Implement real normaliser**

Replace `backend/src/import/normalizeMerchant.ts` with:

```ts
const PROCESSOR_PREFIXES: RegExp[] = [
  /^SQ\s*\*\s*/i,
  /^TST\s*\*\s*/i,
  /^PAYPAL\s*\*\s*/i,
  /^STRIPE\s*\*\s*/i,
  /^GOOGLE\s*\*\s*/i,
  /^GOOGLE\s+\*\s*/i,
  /^DD\s*\*\s*/i,
  /^GH\s*\*\s*/i,
];

const TRAILING_AMZN_MKTP_ID = /\*[A-Z0-9]{4,}$/;
const TRAILING_STORE_NUMBER = /\s+(#\d+|STORE\s*#?\d+|\d{4,6})$/i;
const TRAILING_CITY_STATE = /\s+[A-Z][A-Z'\-]*(?:\s+[A-Z][A-Z'\-]*)*\s+[A-Z]{2}(?:\s+(?:US|USA|CA|CAN))?$/i;
const TRAILING_PHONE = /\s+\+?\d[\d\-.\s()]{6,}\d$/;

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
}

export function normalizeMerchant(raw: unknown): string {
  if (raw == null) return '';
  let s = decodeHtmlEntities(String(raw)).trim().replace(/\s+/g, ' ');
  if (!s) return '';

  for (const re of PROCESSOR_PREFIXES) {
    if (re.test(s)) {
      s = s.replace(re, '').trim();
      break;
    }
  }

  s = s.replace(TRAILING_AMZN_MKTP_ID, '').trim();
  s = s.replace(TRAILING_PHONE, '').trim();

  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(TRAILING_STORE_NUMBER, '').trim();
    s = s.replace(TRAILING_CITY_STATE, '').trim();
  }

  return s.replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd backend && yarn tsx --test test/normalizeMerchant.test.ts`
Expected: all 12 tests pass.

- [ ] **Step 5: Run existing tests that depend on normalizeMerchant**

Run: `cd backend && yarn tsx --test test/mapRow.test.ts`
Expected: pass.

Run: `cd backend && yarn tsx --test test/applyRules.test.ts`
Expected: pass.

- [ ] **Step 6: Run full backend test suite to catch downstream regressions**

Run: `cd backend && yarn test`
Expected: all pass. If any test fails because it depended on the old trivial normalisation behaviour, update that test's expected value (do NOT revert the normaliser).

- [ ] **Step 7: Commit**

```bash
GH_PACKAGES_TOKEN="" git add backend/src/import/normalizeMerchant.ts backend/test/normalizeMerchant.test.ts && \
GH_PACKAGES_TOKEN="" git commit -m "feat(enrichment): real merchant normalisation with processor-prefix and tail stripping"
```

---

## Task 8: Normalize stage (uses real normaliser + brand dict)

**Files:**
- Create: `backend/src/import/enrichment/normalizeStage.ts`
- Modify: `backend/test/brandDictionary.test.ts` (add stage tests under the same file)

Actually create a new test file to keep concerns separate:

- Create: `backend/test/enrichNormalizeStage.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/test/enrichNormalizeStage.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNormalizeStage } from '../src/import/enrichment/normalizeStage';

test('runNormalizeStage cleans and recognises Amazon', () => {
  const signals = runNormalizeStage({ merchantRaw: 'AMZN MKTP US*A1B2C3' });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].source, 'normalize-seed');
  assert.equal(signals[0].confidence, 'high');
  assert.equal(signals[0].fields.merchantClean, 'AMZN MKTP US');
  assert.equal(signals[0].fields.merchantCanonical, 'Amazon');
});

test('runNormalizeStage cleans without canonical when unknown brand', () => {
  const signals = runNormalizeStage({ merchantRaw: "SQ *JOE'S COFFEE TORONTO ON" });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].source, 'normalize-seed');
  assert.equal(signals[0].fields.merchantClean, "JOE'S COFFEE");
  assert.equal(signals[0].fields.merchantCanonical, null);
});

test('runNormalizeStage falls back to learned brand when seed misses but learnedLookup hits', () => {
  const signals = runNormalizeStage({
    merchantRaw: 'JOE COFFEE',
    learnedLookup: (m) => (m === 'JOE COFFEE' ? "Joe's Coffee" : null),
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].source, 'normalize-learned');
  assert.equal(signals[0].confidence, 'medium');
  assert.equal(signals[0].fields.merchantCanonical, "Joe's Coffee");
});

test('runNormalizeStage prefers seed when both match (tie-break)', () => {
  const signals = runNormalizeStage({
    merchantRaw: 'NETFLIX.COM',
    learnedLookup: () => 'Netflix Custom',
  });
  assert.equal(signals[0].source, 'normalize-seed');
  assert.equal(signals[0].fields.merchantCanonical, 'Netflix');
});

test('runNormalizeStage returns merchantClean even for empty input', () => {
  const signals = runNormalizeStage({ merchantRaw: '' });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].fields.merchantClean, '');
  assert.equal(signals[0].fields.merchantCanonical, null);
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `cd backend && yarn tsx --test test/enrichNormalizeStage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the stage**

Create `backend/src/import/enrichment/normalizeStage.ts`:

```ts
import { normalizeMerchant } from '../normalizeMerchant';
import { lookupSeedBrand } from './brandDictionary';
import type { Signal } from './types';

export interface NormalizeStageInput {
  merchantRaw: string;
  /** Optional fallback when seed dict misses. Implementations should be cheap; cache externally. */
  learnedLookup?: (merchantClean: string) => string | null;
}

export function runNormalizeStage(input: NormalizeStageInput): Signal[] {
  const merchantClean = normalizeMerchant(input.merchantRaw);

  const seed = lookupSeedBrand(merchantClean);
  if (seed) {
    return [
      {
        source: 'normalize-seed',
        confidence: 'high',
        fields: { merchantClean, merchantCanonical: seed },
      },
    ];
  }

  const learned = input.learnedLookup ? input.learnedLookup(merchantClean) : null;
  if (learned) {
    return [
      {
        source: 'normalize-learned',
        confidence: 'medium',
        fields: { merchantClean, merchantCanonical: learned },
      },
    ];
  }

  return [
    {
      source: 'normalize-seed',
      confidence: 'high',
      fields: { merchantClean, merchantCanonical: null },
    },
  ];
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd backend && yarn tsx --test test/enrichNormalizeStage.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
GH_PACKAGES_TOKEN="" git add backend/src/import/enrichment/normalizeStage.ts backend/test/enrichNormalizeStage.test.ts && \
GH_PACKAGES_TOKEN="" git commit -m "feat(enrichment): normalize stage with seed and learned brand lookup"
```

---

## Task 9: Detect-type stage

**Files:**
- Create: `backend/src/import/enrichment/detectTypeStage.ts`
- Create: `backend/test/enrichDetectType.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/test/enrichDetectType.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDetectTypeStage } from '../src/import/enrichment/detectTypeStage';

test('refund: narrative says refund + positive amount', () => {
  const signals = runDetectTypeStage({
    merchantRaw: 'AMAZON.COM REFUND',
    merchantClean: 'AMAZON.COM REFUND',
    amount: 42.0,
  });
  assert.equal(signals[0].fields.txnType, 'refund');
  assert.equal(signals[0].confidence, 'high');
});

test('transfer: narrative says transfer + opposite signs handled', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'TRANSFER TO CHEQUING',
    merchantClean: 'TRANSFER TO CHEQUING',
    amount: -500,
  });
  assert.equal(out[0].fields.txnType, 'transfer');
});

test('payment: narrative says online payment + positive', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'ONLINE PAYMENT THANK YOU',
    merchantClean: 'ONLINE PAYMENT THANK YOU',
    amount: 1200,
  });
  assert.equal(out[0].fields.txnType, 'payment');
});

test('fee: narrative says annual fee', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'ANNUAL FEE',
    merchantClean: 'ANNUAL FEE',
    amount: -120,
  });
  assert.equal(out[0].fields.txnType, 'fee');
});

test('interest: interest charge narrative', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'INTEREST CHARGE ON PURCHASES',
    merchantClean: 'INTEREST CHARGE ON PURCHASES',
    amount: -15.5,
  });
  assert.equal(out[0].fields.txnType, 'interest');
});

test('reward: cash back / reward narrative', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'CASH BACK REWARD',
    merchantClean: 'CASH BACK REWARD',
    amount: 25,
  });
  assert.equal(out[0].fields.txnType, 'reward');
});

test('purchase: default when nothing else matches and negative', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'STARBUCKS',
    merchantClean: 'STARBUCKS',
    amount: -6.5,
  });
  assert.equal(out[0].fields.txnType, 'purchase');
  assert.equal(out[0].confidence, 'medium');
});

test('unknown: positive amount with no narrative cue', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'JOE COFFEE',
    merchantClean: 'JOE COFFEE',
    amount: 100,
  });
  assert.equal(out[0].fields.txnType, 'unknown');
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `cd backend && yarn tsx --test test/enrichDetectType.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the stage**

Create `backend/src/import/enrichment/detectTypeStage.ts`:

```ts
import type { Signal, TxnType } from './types';

const PATTERNS: Array<{ type: TxnType; re: RegExp; requireSign?: 'positive' | 'negative' }> = [
  { type: 'refund', re: /\b(refund|return(?:ed)?|reversal|chargeback)\b/i, requireSign: 'positive' },
  { type: 'payment', re: /\b(online payment|payment received|payment thank you|autopay|statement credit)\b/i },
  { type: 'transfer', re: /\b(transfer (?:to|from|in|out)|wire transfer|interac e?-?transfer)\b/i },
  { type: 'fee', re: /\b(annual fee|monthly fee|service fee|nsf fee|late fee|atm fee|fx fee|foreign transaction fee)\b/i },
  { type: 'interest', re: /\b(interest charge|interest on|finance charge)\b/i },
  { type: 'reward', re: /\b(cash ?back|reward|points redemption)\b/i, requireSign: 'positive' },
];

export interface DetectTypeInput {
  merchantRaw: string;
  merchantClean: string;
  amount: number;
}

export function runDetectTypeStage(input: DetectTypeInput): Signal[] {
  const haystack = `${input.merchantRaw} ${input.merchantClean}`.trim();

  for (const p of PATTERNS) {
    if (!p.re.test(haystack)) continue;
    if (p.requireSign === 'positive' && input.amount <= 0) continue;
    if (p.requireSign === 'negative' && input.amount >= 0) continue;
    return [
      {
        source: 'type-detect',
        confidence: 'high',
        fields: { txnType: p.type },
        rationale: `narrative matched ${p.type}`,
      },
    ];
  }

  if (input.amount < 0) {
    return [
      {
        source: 'type-detect',
        confidence: 'medium',
        fields: { txnType: 'purchase' },
        rationale: 'negative amount with no narrative cue',
      },
    ];
  }

  return [
    {
      source: 'type-detect',
      confidence: 'low',
      fields: { txnType: 'unknown' },
      rationale: 'positive amount with no narrative cue',
    },
  ];
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd backend && yarn tsx --test test/enrichDetectType.test.ts`
Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
GH_PACKAGES_TOKEN="" git add backend/src/import/enrichment/detectTypeStage.ts backend/test/enrichDetectType.test.ts && \
GH_PACKAGES_TOKEN="" git commit -m "feat(enrichment): detect-type stage from narrative patterns and sign"
```

---

## Task 10: Apply-rule stage (wraps existing findBestRule)

**Files:**
- Create: `backend/src/import/enrichment/applyRuleStage.ts`
- Create: `backend/test/enrichApplyRule.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/test/enrichApplyRule.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runApplyRuleStage } from '../src/import/enrichment/applyRuleStage';
import type { RuleRow } from '../src/import/applyRules';

function rule(overrides: Partial<RuleRow> & { id: number; merchantPattern: string }): RuleRow {
  return {
    priority: 1,
    matchKind: 'substring',
    category: null,
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
    ...overrides,
  } as RuleRow;
}

test('emits rule signal with high confidence on unambiguous match', () => {
  const signals = runApplyRuleStage({
    merchantClean: 'NETFLIX',
    rules: [rule({ id: 7, merchantPattern: 'NETFLIX', category: 'Subscriptions', isBusiness: false, splitType: 'shared', pctMe: '0.5', pctPartner: '0.5' })],
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].source, 'rule');
  assert.equal(signals[0].confidence, 'high');
  assert.equal(signals[0].fields.autoCategory, 'Subscriptions');
  assert.equal(signals[0].fields.autoSplitType, 'shared');
  assert.equal(signals[0].fields.appliedRuleId, 7);
});

test('emits no signal when no rules match', () => {
  const signals = runApplyRuleStage({
    merchantClean: 'UNKNOWN MERCHANT',
    rules: [rule({ id: 1, merchantPattern: 'NETFLIX' })],
  });
  assert.equal(signals.length, 0);
});

test('emits no signal when rule match is ambiguous', () => {
  const signals = runApplyRuleStage({
    merchantClean: 'COFFEE',
    rules: [
      rule({ id: 1, merchantPattern: 'COFFEE', priority: 5 }),
      rule({ id: 2, merchantPattern: 'COFFEE', priority: 5 }),
    ],
  });
  assert.equal(signals.length, 0);
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `cd backend && yarn tsx --test test/enrichApplyRule.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the stage**

Create `backend/src/import/enrichment/applyRuleStage.ts`:

```ts
import { findBestRule, applyRuleToAuto, type RuleRow } from '../applyRules';
import type { Signal } from './types';

export interface ApplyRuleInput {
  merchantClean: string;
  rules: RuleRow[];
}

export function runApplyRuleStage(input: ApplyRuleInput): Signal[] {
  const { rule, ambiguous } = findBestRule(input.rules, input.merchantClean);
  if (!rule || ambiguous) return [];

  const auto = applyRuleToAuto(rule);
  return [
    {
      source: 'rule',
      confidence: 'high',
      fields: {
        autoCategory: auto.autoCategory,
        autoBusiness: auto.autoBusiness,
        autoSplitType: auto.autoSplitType,
        autoPctMe: auto.autoPctMe,
        autoPctPartner: auto.autoPctPartner,
        appliedRuleId: rule.id,
      },
      rationale: `matched rule pattern "${rule.merchantPattern}"`,
    },
  ];
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd backend && yarn tsx --test test/enrichApplyRule.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
GH_PACKAGES_TOKEN="" git add backend/src/import/enrichment/applyRuleStage.ts backend/test/enrichApplyRule.test.ts && \
GH_PACKAGES_TOKEN="" git commit -m "feat(enrichment): apply-rule stage wrapping findBestRule"
```

---

## Task 11: Merchant-memory stage (wraps existing findMerchantMemory)

**Files:**
- Create: `backend/src/import/enrichment/merchantMemoryStage.ts`
- Create: `backend/test/enrichMerchantMemory.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/test/enrichMerchantMemory.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMerchantMemoryStage } from '../src/import/enrichment/merchantMemoryStage';

test('high confidence when supportCount >= 2', () => {
  const signals = runMerchantMemoryStage({
    memory: {
      merchantClean: 'NETFLIX',
      category: 'Subscriptions',
      business: false,
      splitType: 'shared',
      pctMe: '0.5',
      pctPartner: '0.5',
      supportCount: 4,
      exampleTransactionIds: [11, 12, 13, 14],
    },
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].source, 'memory');
  assert.equal(signals[0].confidence, 'high');
  assert.equal(signals[0].fields.autoCategory, 'Subscriptions');
  assert.equal(signals[0].rationale?.includes('4'), true);
});

test('medium confidence when supportCount = 1', () => {
  const signals = runMerchantMemoryStage({
    memory: {
      merchantClean: 'JOE COFFEE',
      category: 'Dining',
      business: false,
      splitType: 'me',
      pctMe: null,
      pctPartner: null,
      supportCount: 1,
      exampleTransactionIds: [99],
    },
  });
  assert.equal(signals[0].confidence, 'medium');
});

test('no signal when memory is null', () => {
  const signals = runMerchantMemoryStage({ memory: null });
  assert.equal(signals.length, 0);
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `cd backend && yarn tsx --test test/enrichMerchantMemory.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the stage**

Create `backend/src/import/enrichment/merchantMemoryStage.ts`:

```ts
import type { MerchantMemoryMatch } from '../../ai/merchantMemory';
import type { Signal } from './types';

export interface MerchantMemoryInput {
  memory: MerchantMemoryMatch | null;
}

export function runMerchantMemoryStage(input: MerchantMemoryInput): Signal[] {
  const mem = input.memory;
  if (!mem) return [];

  const confidence: 'high' | 'medium' = mem.supportCount >= 2 ? 'high' : 'medium';

  return [
    {
      source: 'memory',
      confidence,
      fields: {
        autoCategory: mem.category,
        autoBusiness: mem.business,
        autoSplitType: mem.splitType,
        autoPctMe: mem.pctMe,
        autoPctPartner: mem.pctPartner,
        notes: `Auto-categorized from ${mem.supportCount} previous ${mem.merchantClean} transaction${mem.supportCount === 1 ? '' : 's'}.`,
      },
      rationale: `merchant memory has ${mem.supportCount} matching prior decision(s)`,
    },
  ];
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd backend && yarn tsx --test test/enrichMerchantMemory.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
GH_PACKAGES_TOKEN="" git add backend/src/import/enrichment/merchantMemoryStage.ts backend/test/enrichMerchantMemory.test.ts && \
GH_PACKAGES_TOKEN="" git commit -m "feat(enrichment): merchant-memory stage with support-count confidence"
```

---

## Task 12: Detect-recurring stage

**Files:**
- Create: `backend/src/import/enrichment/detectRecurringStage.ts`
- Create: `backend/test/enrichDetectRecurring.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/test/enrichDetectRecurring.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDetectRecurringStage, type RecurringHistoryRow } from '../src/import/enrichment/detectRecurringStage';

function row(date: string, amount: number, category: string | null): RecurringHistoryRow {
  return { date, amount, finalCategory: category };
}

test('marks recurring when >=3 monthly-cadence same-amount priors exist', () => {
  const history: RecurringHistoryRow[] = [
    row('2026-02-10', -14.99, 'Subscriptions'),
    row('2026-03-10', -14.99, 'Subscriptions'),
    row('2026-04-10', -14.99, 'Subscriptions'),
  ];
  const signals = runDetectRecurringStage({
    merchantClean: 'NETFLIX',
    amount: -14.99,
    date: '2026-05-10',
    history,
    minSupport: 3,
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].confidence, 'high');
  assert.equal(signals[0].fields.isRecurring, true);
  assert.equal(signals[0].fields.autoCategory, 'Subscriptions');
});

test('no signal when fewer than minSupport priors', () => {
  const history: RecurringHistoryRow[] = [
    row('2026-03-10', -14.99, 'Subscriptions'),
    row('2026-04-10', -14.99, 'Subscriptions'),
  ];
  const signals = runDetectRecurringStage({
    merchantClean: 'NETFLIX',
    amount: -14.99,
    date: '2026-05-10',
    history,
    minSupport: 3,
  });
  assert.equal(signals.length, 0);
});

test('no signal when amounts diverge beyond 5%', () => {
  const history: RecurringHistoryRow[] = [
    row('2026-02-10', -14.99, 'Subscriptions'),
    row('2026-03-10', -19.99, 'Subscriptions'),
    row('2026-04-10', -14.99, 'Subscriptions'),
  ];
  const signals = runDetectRecurringStage({
    merchantClean: 'NETFLIX',
    amount: -14.99,
    date: '2026-05-10',
    history,
    minSupport: 3,
  });
  assert.equal(signals.length, 0);
});

test('no signal when cadence is irregular (not monthly ± 5 days)', () => {
  const history: RecurringHistoryRow[] = [
    row('2026-02-10', -14.99, 'Subscriptions'),
    row('2026-02-25', -14.99, 'Subscriptions'),
    row('2026-04-10', -14.99, 'Subscriptions'),
  ];
  const signals = runDetectRecurringStage({
    merchantClean: 'NETFLIX',
    amount: -14.99,
    date: '2026-05-10',
    history,
    minSupport: 3,
  });
  assert.equal(signals.length, 0);
});

test('picks modal category when priors disagree', () => {
  const history: RecurringHistoryRow[] = [
    row('2026-02-10', -14.99, 'Streaming'),
    row('2026-03-10', -14.99, 'Subscriptions'),
    row('2026-04-10', -14.99, 'Subscriptions'),
  ];
  const signals = runDetectRecurringStage({
    merchantClean: 'NETFLIX',
    amount: -14.99,
    date: '2026-05-10',
    history,
    minSupport: 3,
  });
  assert.equal(signals[0].fields.autoCategory, 'Subscriptions');
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `cd backend && yarn tsx --test test/enrichDetectRecurring.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the stage**

Create `backend/src/import/enrichment/detectRecurringStage.ts`:

```ts
import type { Signal } from './types';

export interface RecurringHistoryRow {
  date: string;
  amount: number;
  finalCategory: string | null;
}

export interface DetectRecurringInput {
  merchantClean: string;
  amount: number;
  date: string;
  history: RecurringHistoryRow[];
  minSupport: number;
}

const MONTHLY_DAYS = 30;
const CADENCE_TOLERANCE_DAYS = 5;
const AMOUNT_TOLERANCE_RATIO = 0.05;

function daysBetween(a: string, b: string): number {
  const ta = new Date(`${a}T00:00:00Z`).getTime();
  const tb = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((ta - tb) / 86400000);
}

function amountWithinRatio(target: number, candidate: number, ratio: number): boolean {
  const base = Math.abs(target);
  if (base === 0) return Math.abs(candidate) === 0;
  return Math.abs(Math.abs(candidate) - base) / base <= ratio;
}

function modalNonNull(values: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (v == null || v.trim() === '') continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [k, n] of counts) {
    if (n > bestCount) {
      best = k;
      bestCount = n;
    }
  }
  return best;
}

export function runDetectRecurringStage(input: DetectRecurringInput): Signal[] {
  const matching = input.history
    .filter((r) => amountWithinRatio(input.amount, r.amount, AMOUNT_TOLERANCE_RATIO))
    .map((r) => ({ ...r, daysAgo: daysBetween(input.date, r.date) }))
    .filter((r) => r.daysAgo > 0)
    .sort((a, b) => a.daysAgo - b.daysAgo);

  if (matching.length < input.minSupport) return [];

  const cadenceOk = matching.slice(0, input.minSupport).every((r, idx) => {
    const expected = (idx + 1) * MONTHLY_DAYS;
    return Math.abs(r.daysAgo - expected) <= CADENCE_TOLERANCE_DAYS;
  });
  if (!cadenceOk) return [];

  const modalCategory = modalNonNull(matching.slice(0, input.minSupport).map((r) => r.finalCategory));

  return [
    {
      source: 'recurring',
      confidence: 'high',
      fields: {
        isRecurring: true,
        autoCategory: modalCategory,
      },
      rationale: `${matching.length} prior monthly-cadence transactions at this merchant + amount`,
    },
  ];
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd backend && yarn tsx --test test/enrichDetectRecurring.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
GH_PACKAGES_TOKEN="" git add backend/src/import/enrichment/detectRecurringStage.ts backend/test/enrichDetectRecurring.test.ts && \
GH_PACKAGES_TOKEN="" git commit -m "feat(enrichment): detect-recurring stage with cadence + amount tolerance"
```

---

## Task 13: Link-items stage (Amazon item linking)

**Files:**
- Create: `backend/src/import/enrichment/linkItemsStage.ts`
- Create: `backend/test/enrichLinkItems.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/test/enrichLinkItems.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLinkItemsStage, type LinkItemsCandidateOrder } from '../src/import/enrichment/linkItemsStage';

function order(overrides: Partial<LinkItemsCandidateOrder> & { id: number; total: number; orderDate: string }): LinkItemsCandidateOrder {
  return {
    shipmentDate: null,
    paymentLast4: null,
    items: [],
    ...overrides,
  };
}

test('skips when merchant is not Amazon-like', () => {
  const signals = runLinkItemsStage({
    merchantRaw: 'JOE COFFEE',
    merchantClean: 'JOE COFFEE',
    amount: -25,
    date: '2026-05-10',
    notes: null,
    sourceReference: null,
    threshold: 70,
    candidateOrders: [order({ id: 1, total: 25, orderDate: '2026-05-09' })],
  });
  assert.equal(signals.length, 0);
});

test('attaches high-confidence link when all items share one inferredCategory', () => {
  const signals = runLinkItemsStage({
    merchantRaw: 'AMZN MKTP US*ABC',
    merchantClean: 'AMZN MKTP US',
    amount: -100,
    date: '2026-05-10',
    notes: null,
    sourceReference: null,
    threshold: 70,
    candidateOrders: [
      order({
        id: 42,
        total: 100,
        orderDate: '2026-05-09',
        items: [
          { id: 1, title: 'USB Cable', totalPrice: '30', inferredCategory: 'Office', businessUsePercent: '0' },
          { id: 2, title: 'Monitor Stand', totalPrice: '70', inferredCategory: 'Office', businessUsePercent: '0' },
        ],
      }),
    ],
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].source, 'amazon-items');
  assert.equal(signals[0].confidence, 'high');
  assert.equal(signals[0].fields.autoCategory, 'Office');
  assert.equal(signals[0].fields.linkedExternalOrderId, 42);
  assert.equal(signals[0].fields.merchantCanonical, 'Amazon');
});

test('uses medium confidence when items have mixed categories; picks highest-totalPrice winner', () => {
  const signals = runLinkItemsStage({
    merchantRaw: 'AMAZON.CA',
    merchantClean: 'AMAZON.CA',
    amount: -130,
    date: '2026-05-10',
    notes: null,
    sourceReference: null,
    threshold: 70,
    candidateOrders: [
      order({
        id: 7,
        total: 130,
        orderDate: '2026-05-09',
        items: [
          { id: 1, title: 'Notebook', totalPrice: '30', inferredCategory: 'Office', businessUsePercent: '0' },
          { id: 2, title: 'Camera Lens', totalPrice: '100', inferredCategory: 'Photography', businessUsePercent: '0' },
        ],
      }),
    ],
  });
  assert.equal(signals[0].confidence, 'medium');
  assert.equal(signals[0].fields.autoCategory, 'Photography');
});

test('proposes business=true when any item has businessUsePercent > 0', () => {
  const signals = runLinkItemsStage({
    merchantRaw: 'AMZN',
    merchantClean: 'AMZN',
    amount: -50,
    date: '2026-05-10',
    notes: null,
    sourceReference: null,
    threshold: 70,
    candidateOrders: [
      order({
        id: 9,
        total: 50,
        orderDate: '2026-05-09',
        items: [{ id: 1, title: 'Pen', totalPrice: '50', inferredCategory: 'Office', businessUsePercent: '100' }],
      }),
    ],
  });
  assert.equal(signals[0].fields.autoBusiness, true);
});

test('skips when match confidence below threshold', () => {
  const signals = runLinkItemsStage({
    merchantRaw: 'AMAZON',
    merchantClean: 'AMAZON',
    amount: -50,
    date: '2026-05-10',
    notes: null,
    sourceReference: null,
    threshold: 70,
    candidateOrders: [
      order({ id: 1, total: 999, orderDate: '2026-01-01', items: [] }),
    ],
  });
  assert.equal(signals.length, 0);
});

test('appends up to 5 item titles to notes (truncated)', () => {
  const signals = runLinkItemsStage({
    merchantRaw: 'AMAZON',
    merchantClean: 'AMAZON',
    amount: -50,
    date: '2026-05-10',
    notes: null,
    sourceReference: null,
    threshold: 70,
    candidateOrders: [
      order({
        id: 1,
        total: 50,
        orderDate: '2026-05-10',
        items: Array.from({ length: 7 }, (_, i) => ({
          id: i + 1,
          title: `Item ${i + 1}`,
          totalPrice: '7',
          inferredCategory: 'Shopping',
          businessUsePercent: '0',
        })),
      }),
    ],
  });
  const notes = signals[0].fields.notes ?? '';
  assert.ok(notes.includes('Item 1'));
  assert.ok(notes.includes('Item 5'));
  assert.ok(!notes.includes('Item 6'));
  assert.ok(notes.length <= 200);
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `cd backend && yarn tsx --test test/enrichLinkItems.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the stage**

Create `backend/src/import/enrichment/linkItemsStage.ts`:

```ts
import { isAmazonLikeMerchant, scoreAmazonOrderMatch } from '../../amazon/matcher';
import type { ExternalOrder } from '../../models/ExternalOrder';
import type { Transaction } from '../../models/Transaction';
import type { Signal } from './types';

export interface LinkItemsCandidateItem {
  id: number;
  title: string;
  totalPrice: string | null;
  inferredCategory: string | null;
  businessUsePercent: string | null;
}

export interface LinkItemsCandidateOrder {
  id: number;
  total: number;
  orderDate: string;
  shipmentDate: string | null;
  paymentLast4: string | null;
  items: LinkItemsCandidateItem[];
}

export interface LinkItemsInput {
  merchantRaw: string;
  merchantClean: string;
  amount: number;
  date: string;
  notes: string | null;
  sourceReference: string | null;
  threshold: number;
  candidateOrders: LinkItemsCandidateOrder[];
}

function num(value: string | null): number {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function buildNotes(items: LinkItemsCandidateItem[]): string {
  const titles = items.slice(0, 5).map((it) => it.title);
  let joined = `Items: ${titles.join(', ')}`;
  if (joined.length > 200) joined = `${joined.slice(0, 197)}...`;
  return joined;
}

export function runLinkItemsStage(input: LinkItemsInput): Signal[] {
  if (!isAmazonLikeMerchant(`${input.merchantRaw} ${input.merchantClean}`)) {
    return [];
  }

  const synthesised: Pick<Transaction, 'amount' | 'date' | 'merchantRaw' | 'merchantClean' | 'notes' | 'sourceReference'> = {
    amount: String(input.amount),
    date: input.date,
    merchantRaw: input.merchantRaw,
    merchantClean: input.merchantClean,
    notes: input.notes,
    sourceReference: input.sourceReference,
  } as Transaction;

  let best: { order: LinkItemsCandidateOrder; confidence: number } | null = null;
  for (const order of input.candidateOrders) {
    const externalOrder: ExternalOrder = {
      total: String(order.total),
      orderDate: order.orderDate,
      shipmentDate: order.shipmentDate,
      paymentLast4: order.paymentLast4,
    } as ExternalOrder;
    const score = scoreAmazonOrderMatch(synthesised as Transaction, externalOrder);
    if (score.confidence >= input.threshold && (!best || score.confidence > best.confidence)) {
      best = { order, confidence: score.confidence };
    }
  }

  if (!best) return [];

  const items = best.order.items;
  const categories = items
    .map((it) => it.inferredCategory)
    .filter((c): c is string => c != null && c.trim() !== '');
  const uniqueCategories = Array.from(new Set(categories));

  let autoCategory: string | null = null;
  let confidence: 'high' | 'medium' = 'medium';

  if (uniqueCategories.length === 1) {
    autoCategory = uniqueCategories[0];
    confidence = 'high';
  } else if (uniqueCategories.length > 1) {
    const winner = items
      .filter((it) => it.inferredCategory != null && it.inferredCategory.trim() !== '')
      .sort((a, b) => num(b.totalPrice) - num(a.totalPrice))[0];
    autoCategory = winner?.inferredCategory ?? null;
    confidence = 'medium';
  }

  const autoBusiness = items.some((it) => num(it.businessUsePercent) > 0) || null;

  return [
    {
      source: 'amazon-items',
      confidence,
      fields: {
        merchantCanonical: 'Amazon',
        autoCategory,
        autoBusiness,
        linkedExternalOrderId: best.order.id,
        notes: buildNotes(items),
      },
      rationale: `linked to Amazon order ${best.order.id} (match confidence ${best.confidence})`,
    },
  ];
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd backend && yarn tsx --test test/enrichLinkItems.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
GH_PACKAGES_TOKEN="" git add backend/src/import/enrichment/linkItemsStage.ts backend/test/enrichLinkItems.test.ts && \
GH_PACKAGES_TOKEN="" git commit -m "feat(enrichment): link-items stage pulls Amazon matcher inline"
```

---

## Task 14: Detect-relationships stage (refund-link + transfer-link)

**Files:**
- Create: `backend/src/import/enrichment/detectRelationshipsStage.ts`
- Create: `backend/test/enrichDetectRelationships.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/test/enrichDetectRelationships.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDetectRelationshipsStage, type RelationshipCandidate } from '../src/import/enrichment/detectRelationshipsStage';

function candidate(overrides: Partial<RelationshipCandidate> & { id: number; amount: number; date: string; merchantClean: string }): RelationshipCandidate {
  return {
    accountId: 1,
    finalCategory: null,
    finalBusiness: false,
    ...overrides,
  };
}

test('refund-link: same merchant + opposite sign + within 60 days links to original', () => {
  const signals = runDetectRelationshipsStage({
    txnType: 'refund',
    merchantClean: 'AMAZON',
    amount: 25,
    date: '2026-05-10',
    accountId: 1,
    householdAccountIds: [1, 2],
    refundWindowDays: 60,
    transferWindowDays: 2,
    candidates: [
      candidate({ id: 100, amount: -25, date: '2026-05-01', merchantClean: 'AMAZON', accountId: 1, finalCategory: 'Shopping' }),
    ],
  });
  const link = signals.find((s) => s.source === 'refund-link');
  assert.ok(link);
  assert.equal(link!.fields.linkedTransactionId, 100);
  assert.equal(link!.fields.autoCategory, 'Shopping');
  assert.equal(link!.confidence, 'high');
});

test('refund-link: no signal when no matching original within window', () => {
  const signals = runDetectRelationshipsStage({
    txnType: 'refund',
    merchantClean: 'AMAZON',
    amount: 25,
    date: '2026-05-10',
    accountId: 1,
    householdAccountIds: [1],
    refundWindowDays: 60,
    transferWindowDays: 2,
    candidates: [],
  });
  assert.equal(signals.filter((s) => s.source === 'refund-link').length, 0);
});

test('transfer-link: opposite-sign matching amount across owned accounts within window', () => {
  const signals = runDetectRelationshipsStage({
    txnType: 'transfer',
    merchantClean: 'TRANSFER TO CHEQUING',
    amount: -500,
    date: '2026-05-10',
    accountId: 1,
    householdAccountIds: [1, 2],
    refundWindowDays: 60,
    transferWindowDays: 2,
    candidates: [
      candidate({ id: 200, amount: 500, date: '2026-05-09', merchantClean: 'TRANSFER FROM AMEX', accountId: 2 }),
    ],
  });
  const link = signals.find((s) => s.source === 'transfer-link');
  assert.ok(link);
  assert.equal(link!.fields.linkedTransactionId, 200);
  assert.equal(link!.fields.autoCategory, 'Transfer');
  assert.equal(link!.confidence, 'high');
});

test('transfer-link: skipped when candidate is on same account', () => {
  const signals = runDetectRelationshipsStage({
    txnType: 'transfer',
    merchantClean: 'TRANSFER',
    amount: -500,
    date: '2026-05-10',
    accountId: 1,
    householdAccountIds: [1, 2],
    refundWindowDays: 60,
    transferWindowDays: 2,
    candidates: [
      candidate({ id: 1, amount: 500, date: '2026-05-09', merchantClean: 'TRANSFER', accountId: 1 }),
    ],
  });
  assert.equal(signals.filter((s) => s.source === 'transfer-link').length, 0);
});

test('non-refund non-transfer types produce no signals', () => {
  const signals = runDetectRelationshipsStage({
    txnType: 'purchase',
    merchantClean: 'STARBUCKS',
    amount: -6,
    date: '2026-05-10',
    accountId: 1,
    householdAccountIds: [1],
    refundWindowDays: 60,
    transferWindowDays: 2,
    candidates: [],
  });
  assert.equal(signals.length, 0);
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `cd backend && yarn tsx --test test/enrichDetectRelationships.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the stage**

Create `backend/src/import/enrichment/detectRelationshipsStage.ts`:

```ts
import type { Signal, TxnType } from './types';

export interface RelationshipCandidate {
  id: number;
  accountId: number;
  amount: number;
  date: string;
  merchantClean: string;
  finalCategory: string | null;
  finalBusiness: boolean;
}

export interface DetectRelationshipsInput {
  txnType: TxnType;
  merchantClean: string;
  amount: number;
  date: string;
  accountId: number;
  householdAccountIds: number[];
  refundWindowDays: number;
  transferWindowDays: number;
  candidates: RelationshipCandidate[];
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Math.round(
    (new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86400000,
  ));
}

function findRefundOriginal(input: DetectRelationshipsInput): RelationshipCandidate | null {
  if (input.amount <= 0) return null;
  const targetSign = -1;
  const matches = input.candidates
    .filter((c) => Math.sign(c.amount) === targetSign)
    .filter((c) => c.merchantClean === input.merchantClean)
    .filter((c) => Math.abs(c.amount) >= Math.abs(input.amount))
    .filter((c) => daysBetween(input.date, c.date) <= input.refundWindowDays)
    .sort((a, b) => daysBetween(input.date, a.date) - daysBetween(input.date, b.date));
  return matches[0] ?? null;
}

function findTransferSibling(input: DetectRelationshipsInput): RelationshipCandidate | null {
  const matches = input.candidates
    .filter((c) => c.accountId !== input.accountId)
    .filter((c) => input.householdAccountIds.includes(c.accountId))
    .filter((c) => Math.sign(c.amount) === -Math.sign(input.amount))
    .filter((c) => Math.abs(Math.abs(c.amount) - Math.abs(input.amount)) <= 0.01)
    .filter((c) => daysBetween(input.date, c.date) <= input.transferWindowDays)
    .sort((a, b) => daysBetween(input.date, a.date) - daysBetween(input.date, b.date));
  return matches[0] ?? null;
}

export function runDetectRelationshipsStage(input: DetectRelationshipsInput): Signal[] {
  const out: Signal[] = [];

  if (input.txnType === 'refund') {
    const original = findRefundOriginal(input);
    if (original) {
      out.push({
        source: 'refund-link',
        confidence: 'high',
        fields: {
          linkedTransactionId: original.id,
          autoCategory: original.finalCategory,
          autoBusiness: original.finalBusiness,
        },
        rationale: `linked to original purchase #${original.id}`,
      });
    }
  }

  if (input.txnType === 'transfer') {
    const sibling = findTransferSibling(input);
    if (sibling) {
      out.push({
        source: 'transfer-link',
        confidence: 'high',
        fields: {
          linkedTransactionId: sibling.id,
          autoCategory: 'Transfer',
        },
        rationale: `linked to sibling transfer #${sibling.id} on account ${sibling.accountId}`,
      });
    }
  }

  return out;
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd backend && yarn tsx --test test/enrichDetectRelationships.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
GH_PACKAGES_TOKEN="" git add backend/src/import/enrichment/detectRelationshipsStage.ts backend/test/enrichDetectRelationships.test.ts && \
GH_PACKAGES_TOKEN="" git commit -m "feat(enrichment): detect-relationships stage with refund + transfer linking"
```

---

## Task 15: Compute-review-flag (precedence merge + final fields)

**Files:**
- Create: `backend/src/import/enrichment/computeReviewFlag.ts`
- Create: `backend/test/enrichComputeReviewFlag.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/test/enrichComputeReviewFlag.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSignals } from '../src/import/enrichment/computeReviewFlag';
import type { Signal } from '../src/import/enrichment/types';

function s(source: Signal['source'], confidence: Signal['confidence'], fields: Signal['fields']): Signal {
  return { source, confidence, fields };
}

test('rule wins over memory and ai for category', () => {
  const merged = mergeSignals([
    s('memory', 'high', { autoCategory: 'Memory' }),
    s('rule', 'high', { autoCategory: 'Rule' }),
    s('ai', 'high', { autoCategory: 'AI' }),
  ]);
  assert.equal(merged.fields.autoCategory, 'Rule');
  assert.equal(merged.fields.autoSource, 'rule');
});

test('rule + memory + amazon-items: rule wins, autoSource=rule', () => {
  const merged = mergeSignals([
    s('memory', 'high', { autoCategory: 'M' }),
    s('rule', 'high', { autoCategory: 'R', appliedRuleId: 5 }),
    s('amazon-items', 'high', { autoCategory: 'A', linkedExternalOrderId: 7 }),
  ]);
  assert.equal(merged.fields.appliedRuleId, 5);
  // amazon-items still contributes a non-conflicting field
  assert.equal(merged.fields.linkedExternalOrderId, 7);
  assert.equal(merged.fields.autoSource, 'composite');
});

test('ai-high alone keeps review_flag=true (AI alone never skips review)', () => {
  const merged = mergeSignals([s('ai', 'high', { autoCategory: 'AI' })]);
  assert.equal(merged.fields.autoCategory, 'AI');
  assert.equal(merged.fields.reviewFlag, true);
});

test('rule-high alone clears review_flag', () => {
  const merged = mergeSignals([s('rule', 'high', { autoCategory: 'R' })]);
  assert.equal(merged.fields.reviewFlag, false);
});

test('memory(1) alone keeps review_flag=true (medium confidence)', () => {
  const merged = mergeSignals([s('memory', 'medium', { autoCategory: 'M' })]);
  assert.equal(merged.fields.reviewFlag, true);
});

test('no signals -> review_flag=true, all auto fields null', () => {
  const merged = mergeSignals([]);
  assert.equal(merged.fields.reviewFlag, true);
  assert.equal(merged.fields.autoCategory, null);
  assert.equal(merged.fields.autoSource, null);
});

test('normalize stage always provides merchantClean even without other signals', () => {
  const merged = mergeSignals([
    s('normalize-seed', 'high', { merchantClean: 'NETFLIX', merchantCanonical: 'Netflix' }),
  ]);
  assert.equal(merged.fields.merchantClean, 'NETFLIX');
  assert.equal(merged.fields.merchantCanonical, 'Netflix');
  // Normalize alone does not provide category → still needs review
  assert.equal(merged.fields.reviewFlag, true);
});

test('refund-link inherits category and clears review_flag', () => {
  const merged = mergeSignals([
    s('refund-link', 'high', { autoCategory: 'Shopping', linkedTransactionId: 7 }),
  ]);
  assert.equal(merged.fields.reviewFlag, false);
  assert.equal(merged.fields.linkedTransactionId, 7);
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `cd backend && yarn tsx --test test/enrichComputeReviewFlag.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement merge + review-flag logic**

Create `backend/src/import/enrichment/computeReviewFlag.ts`:

```ts
import type { Confidence, EnrichmentResult, EnrichmentResultFields, Signal, SignalFields, SignalSource } from './types';

const PRECEDENCE: Array<{ source: SignalSource; minConfidence: Confidence }> = [
  { source: 'rule', minConfidence: 'high' },
  { source: 'recurring', minConfidence: 'high' },
  { source: 'memory', minConfidence: 'high' },
  { source: 'refund-link', minConfidence: 'high' },
  { source: 'transfer-link', minConfidence: 'high' },
  { source: 'amazon-items', minConfidence: 'high' },
  { source: 'ai', minConfidence: 'high' },
  { source: 'memory', minConfidence: 'medium' },
  { source: 'amazon-items', minConfidence: 'medium' },
  { source: 'ai', minConfidence: 'medium' },
  { source: 'normalize-seed', minConfidence: 'high' },
  { source: 'normalize-learned', minConfidence: 'medium' },
  { source: 'type-detect', minConfidence: 'high' },
  { source: 'type-detect', minConfidence: 'medium' },
  { source: 'ai', minConfidence: 'low' },
  { source: 'type-detect', minConfidence: 'low' },
];

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

function signalRank(signal: Signal): number {
  for (let i = 0; i < PRECEDENCE.length; i++) {
    const slot = PRECEDENCE[i];
    if (signal.source === slot.source && CONFIDENCE_RANK[signal.confidence] >= CONFIDENCE_RANK[slot.minConfidence]) {
      return PRECEDENCE.length - i;
    }
  }
  return 0;
}

const AUTO_FIELD_KEYS: Array<keyof SignalFields> = [
  'merchantClean',
  'merchantCanonical',
  'txnType',
  'autoCategory',
  'autoBusiness',
  'autoSplitType',
  'autoPctMe',
  'autoPctPartner',
  'appliedRuleId',
  'linkedTransactionId',
  'linkedExternalOrderId',
  'isRecurring',
  'notes',
];

export function mergeSignals(signals: Signal[]): EnrichmentResult {
  const sorted = [...signals].sort((a, b) => signalRank(b) - signalRank(a));

  const merged: Partial<EnrichmentResultFields> = {};
  const winningSourceByKey = new Map<string, SignalSource>();

  for (const sig of sorted) {
    for (const key of AUTO_FIELD_KEYS) {
      if (!(key in sig.fields)) continue;
      const value = sig.fields[key];
      if (value === undefined) continue;
      if (merged[key as keyof EnrichmentResultFields] !== undefined) continue;
      (merged as Record<string, unknown>)[key] = value;
      winningSourceByKey.set(key, sig.source);
    }
  }

  const distinctSources = new Set(winningSourceByKey.values());
  const autoSource: EnrichmentResultFields['autoSource'] = (() => {
    if (distinctSources.size === 0) return null;
    if (distinctSources.size === 1) return [...distinctSources][0]!;
    return 'composite';
  })();

  // Confidence of the winning category signal (or any winning non-merchantClean signal)
  const categoryWinner = sorted.find((s) => 'autoCategory' in s.fields && s.fields.autoCategory != null);
  const autoConfidence: Confidence | null = categoryWinner?.confidence ?? null;

  const hasCategory = merged.autoCategory != null;
  const hasNonAiHighConfidence = signals.some(
    (s) => s.confidence === 'high' && s.source !== 'ai' && s.fields.autoCategory != null,
  );
  const reviewFlag = !(hasCategory && hasNonAiHighConfidence);

  const fields: EnrichmentResultFields = {
    merchantClean: merged.merchantClean ?? '',
    merchantCanonical: merged.merchantCanonical ?? null,
    txnType: merged.txnType ?? 'purchase',
    autoCategory: merged.autoCategory ?? null,
    autoBusiness: merged.autoBusiness ?? null,
    autoSplitType: merged.autoSplitType ?? null,
    autoPctMe: merged.autoPctMe ?? null,
    autoPctPartner: merged.autoPctPartner ?? null,
    appliedRuleId: merged.appliedRuleId ?? null,
    linkedTransactionId: merged.linkedTransactionId ?? null,
    isRecurring: merged.isRecurring ?? false,
    notes: merged.notes ?? null,
    autoSource,
    autoConfidence,
    reviewFlag,
  };

  return { fields, signals };
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd backend && yarn tsx --test test/enrichComputeReviewFlag.test.ts`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
GH_PACKAGES_TOKEN="" git add backend/src/import/enrichment/computeReviewFlag.ts backend/test/enrichComputeReviewFlag.test.ts && \
GH_PACKAGES_TOKEN="" git commit -m "feat(enrichment): signal merge with precedence ladder and review-flag rule"
```

---

## Task 16: Pipeline orchestrator `enrich.ts` + end-to-end tests

**Files:**
- Create: `backend/src/import/enrich.ts`
- Create: `backend/test/enrichPipeline.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/test/enrichPipeline.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichTransaction, type EnrichInputs } from '../src/import/enrich';
import type { RuleRow } from '../src/import/applyRules';

function rule(o: Partial<RuleRow> & { id: number; merchantPattern: string }): RuleRow {
  return { priority: 1, matchKind: 'substring', category: null, isBusiness: false, splitType: 'me', pctMe: null, pctPartner: null, ...o } as RuleRow;
}

function baseInputs(overrides: Partial<EnrichInputs>): EnrichInputs {
  return {
    raw: { merchantRaw: 'STARBUCKS #123', date: '2026-05-10', amount: -6.5, sourceReference: null, notes: null },
    accountId: 1,
    householdId: null,
    householdAccountIds: [1],
    rules: [],
    amazonOrders: [],
    memory: null,
    recurringHistory: [],
    relationshipCandidates: [],
    refundWindowDays: 60,
    transferWindowDays: 2,
    recurringMinSupport: 3,
    amazonLinkThreshold: 70,
    ...overrides,
  };
}

test('pipeline applies normalize + detect-type for an unmatched merchant', async () => {
  const result = await enrichTransaction(baseInputs({}));
  assert.equal(result.fields.merchantClean, 'STARBUCKS');
  assert.equal(result.fields.txnType, 'purchase');
  assert.equal(result.fields.autoCategory, null);
  assert.equal(result.fields.reviewFlag, true);
});

test('pipeline applies rule and clears review flag', async () => {
  const result = await enrichTransaction(baseInputs({
    rules: [rule({ id: 1, merchantPattern: 'STARBUCKS', category: 'Dining' })],
  }));
  assert.equal(result.fields.autoCategory, 'Dining');
  assert.equal(result.fields.autoSource, 'rule');
  assert.equal(result.fields.reviewFlag, false);
});

test('pipeline applies merchant-memory when no rule matches', async () => {
  const result = await enrichTransaction(baseInputs({
    memory: {
      merchantClean: 'STARBUCKS',
      category: 'Dining',
      business: false,
      splitType: 'me',
      pctMe: null,
      pctPartner: null,
      supportCount: 3,
      exampleTransactionIds: [1, 2, 3],
    },
  }));
  assert.equal(result.fields.autoCategory, 'Dining');
  assert.equal(result.fields.autoSource, 'memory');
  assert.equal(result.fields.reviewFlag, false);
});

test('pipeline marks recurring with monthly history', async () => {
  const result = await enrichTransaction(baseInputs({
    raw: { merchantRaw: 'NETFLIX.COM', date: '2026-05-10', amount: -14.99, sourceReference: null, notes: null },
    recurringHistory: [
      { date: '2026-02-10', amount: -14.99, finalCategory: 'Subscriptions' },
      { date: '2026-03-10', amount: -14.99, finalCategory: 'Subscriptions' },
      { date: '2026-04-10', amount: -14.99, finalCategory: 'Subscriptions' },
    ],
  }));
  assert.equal(result.fields.isRecurring, true);
  assert.equal(result.fields.merchantCanonical, 'Netflix');
});

test('pipeline links refund to original within window', async () => {
  const result = await enrichTransaction(baseInputs({
    raw: { merchantRaw: 'AMAZON.COM REFUND', date: '2026-05-10', amount: 25, sourceReference: null, notes: null },
    relationshipCandidates: [
      { id: 99, accountId: 1, amount: -25, date: '2026-05-01', merchantClean: 'AMAZON.COM REFUND', finalCategory: 'Shopping', finalBusiness: false },
    ],
  }));
  assert.equal(result.fields.linkedTransactionId, 99);
  assert.equal(result.fields.autoCategory, 'Shopping');
});

test('pipeline applies amazon items signal when order matches', async () => {
  const result = await enrichTransaction(baseInputs({
    raw: { merchantRaw: 'AMZN MKTP US*ABC', date: '2026-05-10', amount: -50, sourceReference: null, notes: null },
    amazonOrders: [
      {
        id: 42,
        total: 50,
        orderDate: '2026-05-09',
        shipmentDate: null,
        paymentLast4: null,
        items: [{ id: 1, title: 'USB Cable', totalPrice: '50', inferredCategory: 'Office', businessUsePercent: '0' }],
      },
    ],
  }));
  assert.equal(result.fields.merchantCanonical, 'Amazon');
  // amazon-items alone is high confidence but NOT in the non-AI-high set per precedence? Actually it IS non-AI.
  assert.equal(result.fields.autoCategory, 'Office');
  assert.equal(result.fields.reviewFlag, false);
});

test('pipeline returns all stage signals in result', async () => {
  const result = await enrichTransaction(baseInputs({
    rules: [rule({ id: 1, merchantPattern: 'STARBUCKS', category: 'Dining' })],
  }));
  const sources = result.signals.map((s) => s.source);
  assert.ok(sources.includes('normalize-seed'));
  assert.ok(sources.includes('type-detect'));
  assert.ok(sources.includes('rule'));
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `cd backend && yarn tsx --test test/enrichPipeline.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the orchestrator**

Create `backend/src/import/enrich.ts`:

```ts
import { mergeSignals } from './enrichment/computeReviewFlag';
import { runNormalizeStage } from './enrichment/normalizeStage';
import { runDetectTypeStage } from './enrichment/detectTypeStage';
import { runDetectRecurringStage, type RecurringHistoryRow } from './enrichment/detectRecurringStage';
import { runApplyRuleStage } from './enrichment/applyRuleStage';
import { runMerchantMemoryStage } from './enrichment/merchantMemoryStage';
import { runLinkItemsStage, type LinkItemsCandidateOrder } from './enrichment/linkItemsStage';
import { runDetectRelationshipsStage, type RelationshipCandidate } from './enrichment/detectRelationshipsStage';
import type { EnrichmentResult, Signal, TxnType } from './enrichment/types';
import type { RuleRow } from './applyRules';
import type { MerchantMemoryMatch } from '../ai/merchantMemory';

export interface EnrichRawInputs {
  merchantRaw: string;
  date: string;
  amount: number;
  sourceReference: string | null;
  notes: string | null;
}

export interface EnrichInputs {
  raw: EnrichRawInputs;
  accountId: number;
  householdId: number | null;
  householdAccountIds: number[];
  rules: RuleRow[];
  amazonOrders: LinkItemsCandidateOrder[];
  memory: MerchantMemoryMatch | null;
  recurringHistory: RecurringHistoryRow[];
  relationshipCandidates: RelationshipCandidate[];
  refundWindowDays: number;
  transferWindowDays: number;
  recurringMinSupport: number;
  amazonLinkThreshold: number;
  /** Optional learned-brand lookup for stage 1; orchestrator may pass a memo'd resolver. */
  learnedBrandLookup?: (merchantClean: string) => string | null;
}

function pickTxnType(signals: Signal[]): TxnType {
  for (const s of signals) {
    if (s.fields.txnType) return s.fields.txnType;
  }
  return 'purchase';
}

function pickMerchantClean(signals: Signal[]): string {
  for (const s of signals) {
    if (s.fields.merchantClean != null) return s.fields.merchantClean;
  }
  return '';
}

export async function enrichTransaction(input: EnrichInputs): Promise<EnrichmentResult> {
  const signals: Signal[] = [];

  // Stage 1: normalize
  signals.push(...runNormalizeStage({
    merchantRaw: input.raw.merchantRaw,
    learnedLookup: input.learnedBrandLookup,
  }));

  const merchantClean = pickMerchantClean(signals);

  // Stage 2: detect-type
  signals.push(...runDetectTypeStage({
    merchantRaw: input.raw.merchantRaw,
    merchantClean,
    amount: input.raw.amount,
  }));

  const txnType = pickTxnType(signals);

  // Stage 3: detect-recurring
  signals.push(...runDetectRecurringStage({
    merchantClean,
    amount: input.raw.amount,
    date: input.raw.date,
    history: input.recurringHistory,
    minSupport: input.recurringMinSupport,
  }));

  // Stage 4: apply-rule
  signals.push(...runApplyRuleStage({
    merchantClean,
    rules: input.rules,
  }));

  // Stage 5: merchant-memory
  signals.push(...runMerchantMemoryStage({
    memory: input.memory,
  }));

  // Stage 6: link-items
  signals.push(...runLinkItemsStage({
    merchantRaw: input.raw.merchantRaw,
    merchantClean,
    amount: input.raw.amount,
    date: input.raw.date,
    notes: input.raw.notes,
    sourceReference: input.raw.sourceReference,
    threshold: input.amazonLinkThreshold,
    candidateOrders: input.amazonOrders,
  }));

  // Stage 7: detect-relationships
  signals.push(...runDetectRelationshipsStage({
    txnType,
    merchantClean,
    amount: input.raw.amount,
    date: input.raw.date,
    accountId: input.accountId,
    householdAccountIds: input.householdAccountIds,
    refundWindowDays: input.refundWindowDays,
    transferWindowDays: input.transferWindowDays,
    candidates: input.relationshipCandidates,
  }));

  // Stage 9: compute-review-flag (merge)
  return mergeSignals(signals);
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd backend && yarn tsx --test test/enrichPipeline.test.ts`
Expected: 7 tests pass.

- [ ] **Step 5: Run full backend test suite**

Run: `cd backend && yarn test`
Expected: all pass.

- [ ] **Step 6: Typecheck**

Run: `cd backend && yarn typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
GH_PACKAGES_TOKEN="" git add backend/src/import/enrich.ts backend/test/enrichPipeline.test.ts && \
GH_PACKAGES_TOKEN="" git commit -m "feat(enrichment): pipeline orchestrator wires stages 1-7 and review-flag"
```

---

## Task 17: Extract shared enrichment loaders

**Files:**
- Create: `backend/src/import/enrichment/loaders.ts`

These helpers are used by both `runImport.ts` (Task 18) and `commitStatementImport.ts` (Task 19). Extracted now to keep both wiring tasks self-contained.

- [ ] **Step 1: Create the loaders module**

Create `backend/src/import/enrichment/loaders.ts`:

```ts
import { QueryTypes } from 'sequelize';
import { sequelize, Account, ExternalOrder, ExternalOrderItem } from '../../models';
import type { ExternalOrderItem as ExternalOrderItemType } from '../../models/ExternalOrderItem';
import type { LinkItemsCandidateOrder } from './linkItemsStage';
import type { RecurringHistoryRow } from './detectRecurringStage';
import type { RelationshipCandidate } from './detectRelationshipsStage';

export async function loadAmazonOrdersCache(householdId: number | null): Promise<LinkItemsCandidateOrder[]> {
  const orders = await ExternalOrder.findAll({
    where: householdId != null ? { householdId, vendor: 'amazon' } : { vendor: 'amazon' },
    include: [{ model: ExternalOrderItem, as: 'items' }],
  });
  return orders.map((o) => ({
    id: o.id,
    total: Number(o.total ?? 0),
    orderDate: o.orderDate ?? '',
    shipmentDate: o.shipmentDate,
    paymentLast4: o.paymentLast4,
    items: ((o as unknown as { items?: ExternalOrderItemType[] }).items ?? []).map((it) => ({
      id: it.id,
      title: it.title,
      totalPrice: it.totalPrice,
      inferredCategory: it.inferredCategory,
      businessUsePercent: it.businessUsePercent,
    })),
  }));
}

export async function loadHouseholdAccountIds(accountId: number, householdId: number | null): Promise<number[]> {
  const rows = await Account.findAll({
    where: householdId != null ? { householdId } : { id: accountId },
    attributes: ['id'],
  });
  const ids = rows.map((r) => r.id);
  if (!ids.includes(accountId)) ids.push(accountId);
  return ids;
}

export async function loadRecurringHistory(
  householdId: number | null,
  merchantClean: string,
  beforeDate: string,
): Promise<RecurringHistoryRow[]> {
  if (!merchantClean) return [];
  const rows = await sequelize.query<{ date: string; amount: number; finalCategory: string | null }>(
    `SELECT date, CAST(amount AS REAL) AS amount, final_category AS "finalCategory"
       FROM transactions
       WHERE (? IS NULL OR household_id = ?)
         AND LOWER(merchant_clean) = LOWER(?)
         AND date < ?
       ORDER BY date DESC LIMIT 12`,
    {
      replacements: [householdId, householdId, merchantClean, beforeDate],
      type: QueryTypes.SELECT,
    },
  );
  return rows.map((r) => ({ date: r.date, amount: Number(r.amount), finalCategory: r.finalCategory }));
}

export async function loadRelationshipCandidates(
  householdId: number | null,
  householdAccountIds: number[],
  merchantClean: string,
  date: string,
  refundWindowDays: number,
): Promise<RelationshipCandidate[]> {
  if (householdAccountIds.length === 0) return [];
  const placeholders = householdAccountIds.map(() => '?').join(',');
  const rows = await sequelize.query<{
    id: number;
    accountId: number;
    amount: number;
    date: string;
    merchantClean: string;
    finalCategory: string | null;
    finalBusiness: number;
  }>(
    `SELECT id, account_id AS "accountId", CAST(amount AS REAL) AS amount, date,
            merchant_clean AS "merchantClean", final_category AS "finalCategory",
            final_business AS "finalBusiness"
       FROM transactions
       WHERE account_id IN (${placeholders})
         AND ABS(julianday(?) - julianday(date)) <= ?
         AND (merchant_clean = ? OR (? IS NULL OR household_id = ?))`,
    {
      replacements: [...householdAccountIds, date, refundWindowDays, merchantClean, householdId, householdId],
      type: QueryTypes.SELECT,
    },
  );
  return rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    amount: Number(r.amount),
    date: r.date,
    merchantClean: r.merchantClean,
    finalCategory: r.finalCategory,
    finalBusiness: Boolean(r.finalBusiness),
  }));
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && yarn typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
GH_PACKAGES_TOKEN="" git add backend/src/import/enrichment/loaders.ts && \
GH_PACKAGES_TOKEN="" git commit -m "feat(enrichment): shared DB loaders for pipeline context"
```

---

## Task 18: Wire pipeline into `runImport.ts` (CSV upload path)

**Files:**
- Modify: `backend/src/import/runImport.ts`

- [ ] **Step 1: Update imports**

In `backend/src/import/runImport.ts`:

Remove the imports for `applyRuleToAuto` and `findBestRule` (keep `loadAllRules`). Remove the import for `merchantMemoryToAutoFields` (keep `findMerchantMemory`).

Add these imports near the existing import block:

```ts
import { enrichTransaction } from './enrich';
import { TransactionSignal } from '../models';
import {
  enrichmentRecurringMinSupport,
  enrichmentAmazonLinkThreshold,
  enrichmentRefundWindowDays,
  enrichmentTransferWindowDays,
} from '../config/env';
import {
  loadAmazonOrdersCache,
  loadHouseholdAccountIds,
  loadRecurringHistory,
  loadRelationshipCandidates,
} from './enrichment/loaders';
```

- [ ] **Step 2: Pre-load the Amazon orders cache once per import**

Inside `importCsvFile`, immediately after `const rules = await loadAllRules(opts.householdId);` (line ~97), add:

```ts
const amazonOrdersCache = await loadAmazonOrdersCache(opts.householdId ?? null);
```

- [ ] **Step 3: Replace the auto-fill block in the row loop**

Inside the `for (let i = 0; i < records.length; i++)` loop in `importCsvFile`, find the block from `const { rule, ambiguous } = findBestRule(...)` through `const reviewFlag = true;` (currently lines 250-267). Replace with:

```ts
const householdAccountIds = await loadHouseholdAccountIds(account.id, opts.householdId ?? account.householdId ?? null);

// Stage 5 input (deterministic; AI memory only)
const memory = await findMerchantMemory(opts.householdId ?? account.householdId ?? null, v.merchantClean);

// Stages 3 + 7 inputs need DB lookups keyed on current cleaned merchant + date window
const cleaned = v.merchantClean; // mapRow already calls normalizeMerchant; pipeline will re-clean

const recurringHistory = await loadRecurringHistory(
  opts.householdId ?? account.householdId ?? null,
  cleaned,
  v.date,
);
const relationshipCandidates = await loadRelationshipCandidates(
  opts.householdId ?? account.householdId ?? null,
  householdAccountIds,
  cleaned,
  v.date,
  enrichmentRefundWindowDays,
);

const enriched = await enrichTransaction({
  raw: {
    merchantRaw: v.merchantRaw,
    date: v.date,
    amount: v.amount,
    sourceReference: v.sourceReference,
    notes: null,
  },
  accountId: account.id,
  householdId: opts.householdId ?? account.householdId ?? null,
  householdAccountIds,
  rules,
  amazonOrders: amazonOrdersCache,
  memory,
  recurringHistory,
  relationshipCandidates,
  refundWindowDays: enrichmentRefundWindowDays,
  transferWindowDays: enrichmentTransferWindowDays,
  recurringMinSupport: enrichmentRecurringMinSupport,
  amazonLinkThreshold: enrichmentAmazonLinkThreshold,
});

const f = enriched.fields;
```

- [ ] **Step 4: Update the `Transaction.build({...})` call to use enrichment fields**

Replace the `Transaction.build({...})` block (around line 269 in the original file) with:

```ts
const txn = Transaction.build({
  accountId: account.id,
  householdId: opts.householdId ?? account.householdId ?? null,
  createdByUserId: opts.userId ?? account.ownerUserId ?? null,
  visibility: account.visibility === 'shared' ? 'shared' : 'private',
  ownershipType:
    f.autoSplitType === 'partner' || f.autoSplitType === 'shared' ? f.autoSplitType : 'me',
  ownershipContactId: null,
  importBatch,
  date: v.date,
  merchantRaw: v.merchantRaw,
  merchantClean: f.merchantClean,
  merchantCanonical: f.merchantCanonical,
  txnType: f.txnType,
  amount: String(v.amount),
  currency: v.currency,
  notes: f.notes,
  sourceReference: v.sourceReference,
  sourceRowFingerprint: fp,
  appliedRuleId: f.appliedRuleId,
  autoCategory: f.autoCategory,
  autoBusiness: f.autoBusiness,
  autoSplitType: f.autoSplitType,
  autoPctMe: f.autoPctMe,
  autoPctPartner: f.autoPctPartner,
  categoryOverride: null,
  businessOverride: null,
  splitOverride: null,
  pctMeOverride: null,
  pctPartnerOverride: null,
  autoSource: f.autoSource,
  autoConfidence: f.autoConfidence,
  linkedTransactionId: f.linkedTransactionId,
  isRecurring: f.isRecurring,
  reviewFlag: f.reviewFlag,
  reviewedAt: null,
});
```

- [ ] **Step 5: Persist signals after txn.save**

In the same loop, after `await txn.save({ transaction: t });`, before `inserted += 1;`, add:

```ts
if (enriched.signals.length > 0) {
  await TransactionSignal.bulkCreate(
    enriched.signals.map((s) => ({
      transactionId: txn.id,
      source: s.source,
      confidence: s.confidence,
      fields: s.fields,
      rationale: s.rationale ?? null,
    })),
    { transaction: t },
  );
}
```

- [ ] **Step 6: Typecheck**

Run: `cd backend && yarn typecheck`
Expected: no errors. Fix any unused-import lint warnings.

- [ ] **Step 7: Run import-related tests**

Run: `cd backend && yarn tsx --test test/runImportParseErrors.test.ts`
Expected: pass.

Run: `cd backend && yarn test`
Expected: all pass. Note that previously-implicit `review_flag=true` assumptions in existing tests may now fail — for those, update the expected value to reflect the new confidence-driven behaviour (do NOT revert the pipeline).

- [ ] **Step 8: Commit**

```bash
GH_PACKAGES_TOKEN="" git add backend/src/import/runImport.ts && \
GH_PACKAGES_TOKEN="" git commit -m "feat(enrichment): wire enrichment pipeline into runImport"
```

If the previous step required updating existing tests, include those in the same commit.

---

## Task 19: Wire pipeline into `commitStatementImport.ts` (preview/commit path)

**Files:**
- Modify: `backend/src/import/commitStatementImport.ts`

- [ ] **Step 1: Read existing auto-fill block**

Run: `cd backend && sed -n '195,230p' src/import/commitStatementImport.ts`

Locate the block that currently calls `findBestRule` + `findMerchantMemory` + `merchantMemoryToAutoFields` (around lines 204-220 per the spec).

- [ ] **Step 2: Update imports**

In `backend/src/import/commitStatementImport.ts`:

Remove the imports for `applyRuleToAuto`, `findBestRule`, and `merchantMemoryToAutoFields`.

Add these imports:

```ts
import { enrichTransaction } from './enrich';
import { TransactionSignal } from '../models';
import {
  enrichmentRecurringMinSupport,
  enrichmentAmazonLinkThreshold,
  enrichmentRefundWindowDays,
  enrichmentTransferWindowDays,
} from '../config/env';
import {
  loadAmazonOrdersCache,
  loadHouseholdAccountIds,
  loadRecurringHistory,
  loadRelationshipCandidates,
} from './enrichment/loaders';
```

- [ ] **Step 3: Pre-load Amazon orders cache once per commit operation**

Immediately after the rules cache is loaded in `commitStatementImport`, add:

```ts
const amazonOrdersCache = await loadAmazonOrdersCache(account.householdId ?? null);
```

If a `householdId` variable already exists at that scope, use it. Otherwise resolve from the account.

- [ ] **Step 4: Replace the auto-fill block in the row loop**

In the existing row loop, find the `findBestRule` + `findMerchantMemory` + `merchantMemoryToAutoFields` block. Replace with:

```ts
const householdAccountIds = await loadHouseholdAccountIds(account.id, account.householdId ?? null);

const memory = await findMerchantMemory(account.householdId ?? null, row.merchantClean);

const recurringHistory = await loadRecurringHistory(
  account.householdId ?? null,
  row.merchantClean,
  row.date,
);
const relationshipCandidates = await loadRelationshipCandidates(
  account.householdId ?? null,
  householdAccountIds,
  row.merchantClean,
  row.date,
  enrichmentRefundWindowDays,
);

const enriched = await enrichTransaction({
  raw: {
    merchantRaw: row.merchantRaw,
    date: row.date,
    amount: row.amount,
    sourceReference: row.sourceReference ?? null,
    notes: null,
  },
  accountId: account.id,
  householdId: account.householdId ?? null,
  householdAccountIds,
  rules,
  amazonOrders: amazonOrdersCache,
  memory,
  recurringHistory,
  relationshipCandidates,
  refundWindowDays: enrichmentRefundWindowDays,
  transferWindowDays: enrichmentTransferWindowDays,
  recurringMinSupport: enrichmentRecurringMinSupport,
  amazonLinkThreshold: enrichmentAmazonLinkThreshold,
});

const f = enriched.fields;
```

(Adjust variable names — `row` vs `v`, etc — to match the local symbols in `commitStatementImport.ts`.)

- [ ] **Step 5: Update the `Transaction.build({...})` call**

Replace the existing build to include the new enrichment fields and use `f.reviewFlag` instead of `true`:

```ts
const txn = Transaction.build({
  accountId: account.id,
  householdId: account.householdId ?? null,
  createdByUserId: account.ownerUserId ?? null,
  visibility: account.visibility === 'shared' ? 'shared' : 'private',
  ownershipType:
    f.autoSplitType === 'partner' || f.autoSplitType === 'shared' ? f.autoSplitType : 'me',
  ownershipContactId: null,
  importBatch,
  date: row.date,
  merchantRaw: row.merchantRaw,
  merchantClean: f.merchantClean,
  merchantCanonical: f.merchantCanonical,
  txnType: f.txnType,
  amount: String(row.amount),
  currency: row.currency,
  notes: f.notes,
  sourceReference: row.sourceReference ?? null,
  sourceRowFingerprint: fp,
  appliedRuleId: f.appliedRuleId,
  autoCategory: f.autoCategory,
  autoBusiness: f.autoBusiness,
  autoSplitType: f.autoSplitType,
  autoPctMe: f.autoPctMe,
  autoPctPartner: f.autoPctPartner,
  categoryOverride: null,
  businessOverride: null,
  splitOverride: null,
  pctMeOverride: null,
  pctPartnerOverride: null,
  autoSource: f.autoSource,
  autoConfidence: f.autoConfidence,
  linkedTransactionId: f.linkedTransactionId,
  isRecurring: f.isRecurring,
  reviewFlag: f.reviewFlag,
  reviewedAt: null,
});
```

(Adjust `createdByUserId`, `importBatch`, `fp` etc. to use whatever local symbols already exist in this file.)

- [ ] **Step 6: Persist signals after txn.save**

After `await txn.save({ transaction: t });` (or however the file commits the row), add:

```ts
if (enriched.signals.length > 0) {
  await TransactionSignal.bulkCreate(
    enriched.signals.map((s) => ({
      transactionId: txn.id,
      source: s.source,
      confidence: s.confidence,
      fields: s.fields,
      rationale: s.rationale ?? null,
    })),
    { transaction: t },
  );
}
```

- [ ] **Step 7: Typecheck and test**

Run: `cd backend && yarn typecheck`
Expected: no errors.

Run: `cd backend && yarn test`
Expected: all pass.

Run: `cd backend && yarn test:integration`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
GH_PACKAGES_TOKEN="" git add backend/src/import/commitStatementImport.ts && \
GH_PACKAGES_TOKEN="" git commit -m "feat(enrichment): wire enrichment pipeline into commitStatementImport"
```

---

## Task 20: Final smoke pass (full pipeline integration)

**Files:**
- Modify: `backend/test/integration/` (existing integration test — find one for import and extend)

- [ ] **Step 1: Identify the integration test that exercises an end-to-end import**

Run: `ls backend/test/integration/`

Pick the test most related to CSV/statement import (look for `import` in filenames).

- [ ] **Step 2: Read the test, find the CSV-import scenario**

If none covers it: skip to step 4 (write new). Otherwise, extend it.

- [ ] **Step 3: Add or write integration assertions**

Add assertions verifying:
- After importing a CSV with one known-rule merchant (e.g., "NETFLIX"), the resulting transaction has `auto_source='rule'`, `auto_confidence='high'`, `review_flag=false`.
- A second row with no rule and no memory has `review_flag=true`, `auto_source` null.
- `transaction_signals` rows exist for each saved transaction with at least the `normalize-seed` source.

- [ ] **Step 4: Run integration tests**

Run: `cd backend && yarn test:integration`
Expected: all pass.

- [ ] **Step 5: Run full backend test suite**

Run: `cd backend && yarn test && yarn test:integration && yarn typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
GH_PACKAGES_TOKEN="" git add backend/test/integration/ && \
GH_PACKAGES_TOKEN="" git commit -m "test(enrichment): integration assertions for confidence-driven review_flag"
```

---

## Self-Review checklist (run after writing this plan)

- [x] **Spec coverage** — every section of the spec is addressed by a task: migration ✓, model ✓, types ✓, brand dict ✓, normalize ✓, detect-type ✓, detect-recurring ✓, apply-rule ✓, merchant-memory ✓, link-items ✓, detect-relationships ✓, compute-review-flag ✓, orchestrator ✓, runImport wiring ✓, commitStatementImport wiring ✓, integration test ✓. Deferred to Plan 2: ai-batch, phase-2 two-phase flow, POST /api/transactions/:id/enrich, backfill script, Review Inbox UI.
- [x] **Placeholder scan** — no "TBD"/"TODO"/"implement later"/"similar to" without code provided. Every TDD step has explicit code.
- [x] **Type consistency** — `Signal`, `SignalSource`, `Confidence`, `TxnType`, `EnrichmentResult`, `EnrichmentResultFields`, `EnrichInputs` are defined once and referenced consistently across stages and orchestrator.
- [x] **Imports** — `mapRow.ts` and `parseStatementFile.ts` continue importing `normalizeMerchant` from the same path; behaviour change is internal.

---

## What Plan 2 will cover

- `ai-batch` stage and per-row fallback (the deferred-cold-row half of phase-1/phase-2 import flow).
- Two-phase import orchestration in `runImport.ts` + `commitStatementImport.ts`: save high-confidence rows immediately, defer cold rows for batched AI processing, then save.
- `POST /api/transactions/:id/enrich` endpoint with rate-limiting and override safety.
- `backend/scripts/backfillEnrichment.ts` — historical re-enrichment with `--no-ai` default.
- Review Inbox UI: display `transaction_signals` as a "Why" tooltip per row.
- New env vars: `ENRICHMENT_AI_ENABLED`, `ENRICHMENT_AI_MAX_MERCHANTS_PER_IMPORT`, `ENRICHMENT_AI_PER_ROW_CONCURRENCY`.
