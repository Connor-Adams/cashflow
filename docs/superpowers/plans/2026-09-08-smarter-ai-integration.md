# Smarter AI Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CFO briefing, the insights page, and transaction categorization actually intelligent by scheduling the detectors that already exist, folding a duplicate insight engine into them, adding a narrative synthesis pass to the briefing, and feeding past user corrections back into categorization prompts.

**Architecture:** Four independent parts. Part 1 registers the existing eight-detector run as a scheduled job. Part 2 folds `backend/src/ai/insights.ts` (six hardcoded templates) out of existence by repointing its three consumers at `Insight` rows. Part 3 adds an LLM pass over the briefing's deterministic action items that ranks and narrates them without inventing figures. Part 4 mines `AiSuggestion` rows the user edited and injects them into the categorization prompt as negatives.

**Tech Stack:** TypeScript, Express, Sequelize (dual-dialect SQLite/Postgres), `node:test` via `tsx` for backend tests, existing in-house job scheduler (`backend/src/jobs/`), OpenAI chat-completions via `backend/src/ai/openaiJson.ts`.

**Source spec:** `docs/superpowers/specs/2026-09-08-smarter-ai-integration-design.md`

## Global Constraints

- Run all commands from the **repo root**. Never install or run from a sub-directory.
- Backend unit tests are **colocated**: `foo.test.ts` beside `foo.ts` under `backend/src/`. They are auto-discovered — no glob to update.
- Backend tests use **`node:test` via `tsx`**, not vitest or jest. Single file: `cd backend && yarn tsx --import ./test/setup.ts --test src/path/to/file.test.ts`
- Write Sequelize that runs on **both SQLite and Postgres**. No dialect-specific SQL without a `dialectSql` helper.
- **Never call a real model in a unit test.** Stub the module boundary.
- **No `Co-Authored-By` trailers** in commit messages.
- `backend/src/routes/ai.ts:449` declares a **local** `type InsightSeverity = 'action' | 'watch' | 'info'` that shadows the model's `InsightSeverity = 'info' | 'warning' | 'critical'` from `backend/src/models/Insight.ts:16`. These are different types with the same name. Do not conflate them.
- Typecheck with `yarn workspace cashflow-backend run typecheck` before each commit.

---

## File Structure

**Part 1 — schedule the detectors**
- Create `backend/src/insights/runAllHouseholdDetectors.ts` — iterates households, calls `runDetectorsForHousehold` per household, isolates per-household failures. Holds the logic so the job definition stays thin (matches `runWeeklyDigest` / `runBudgetBreachCheck`).
- Create `backend/src/insights/runAllHouseholdDetectors.test.ts`
- Create `backend/src/jobs/definitions/runInsightDetectors.ts` — ~12-line `defineJob` wrapper.
- Modify `backend/src/config/env.ts` — add `insightDetectorsEnabled` / `insightDetectorsCron`.
- Modify `backend/src/config/env.test.ts` — cover the new parser.
- Modify `backend/src/server.ts` — import the definition.

**Part 2 — fold the forked engine**
- Create `backend/src/insights/toActionItems.ts` — pure mappers from `Insight` rows to `CfoBriefingActionItem`. Shared by the briefing and the review runner so the mapping exists once.
- Create `backend/src/insights/toActionItems.test.ts`
- Modify `backend/src/cfo/briefingBuilder.ts` — swap `buildFinancialInsights` for an `Insight` query.
- Modify `backend/src/ai/reviewRunner.ts` — same swap.
- Modify `backend/src/routes/ai.ts` — repoint the inbox's `financial_insight` slot; delete the `GET /api/ai/insights` route and `supersedeFinancialInsightDupes`.
- Delete `backend/src/ai/insights.ts` and `backend/src/ai/insightsNoCategory.test.ts`.

**Part 3 — briefing synthesis**
- Create `backend/src/cfo/synthesizeBriefing.ts` — prompt construction, strict-JSON call, and the parser that rejects fabricated ids. Kept separate from `briefingBuilder.ts`, which is already 538 lines.
- Create `backend/src/cfo/synthesizeBriefing.test.ts`
- Modify `backend/src/cfo/briefingBuilder.ts` — call the synthesis pass, degrade gracefully.

**Part 4 — correction feedback**
- Modify `backend/src/ai/merchantMemory.ts` — export `normalizeMerchantKey`.
- Create `backend/src/ai/pastCorrections.ts` — query edited `AiSuggestion` rows for a merchant.
- Create `backend/src/ai/pastCorrections.test.ts`
- Modify `backend/src/ai/suggestTransaction.ts` — add `pastCorrections` to the context and the prompt; bump the prompt version; delete `suggestTransactionFields`.
- Modify `backend/src/routes/transactions.ts` — drop the `suggestTransactionFields` import.

---

# Part 1 — Schedule the detectors

### Task 1: Env config for the detector job

**Files:**
- Modify: `backend/src/config/env.ts`
- Test: `backend/src/config/env.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `env.insightDetectorsEnabled: boolean`, `env.insightDetectorsCron: string`, `parseInsightDetectorsEnabled(raw: string | undefined, nodeEnv: string): boolean`.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/config/env.test.ts`:

```ts
import { parseInsightDetectorsEnabled } from './env';

test('parseInsightDetectorsEnabled defaults on outside test env', () => {
  assert.equal(parseInsightDetectorsEnabled(undefined, 'production'), true);
});

test('parseInsightDetectorsEnabled defaults off in test env', () => {
  assert.equal(parseInsightDetectorsEnabled(undefined, 'test'), false);
});

test('parseInsightDetectorsEnabled honours explicit values', () => {
  assert.equal(parseInsightDetectorsEnabled('false', 'production'), false);
  assert.equal(parseInsightDetectorsEnabled('true', 'test'), true);
});
```

If `env.test.ts` does not already import `test`/`assert`, match the imports the file's existing tests use.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/config/env.test.ts`
Expected: FAIL — `parseInsightDetectorsEnabled` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/config/env.ts`, add to the resolved-config type (beside `subscriptionPriceDetectCron` at line 37):

```ts
  insightDetectorsEnabled: boolean;
  insightDetectorsCron: string;
```

Add the parser beside `parseSubscriptionPriceDetectEnabled` (line 336):

```ts
export function parseInsightDetectorsEnabled(
  raw: string | undefined,
  nodeEnv: string,
): boolean {
  const trimmed = raw?.trim().toLowerCase();
  if (trimmed && QUOTE_TRUTHY.has(trimmed)) return true;
  if (trimmed && QUOTE_FALSY.has(trimmed)) return false;
  if (nodeEnv === 'test') return false;
  return true;
}
```

In the resolver body, beside line 186:

```ts
  const insightDetectorsEnabled = parseInsightDetectorsEnabled(
    e.INSIGHT_DETECTORS_ENABLED,
    nodeEnv,
  );
  const insightDetectorsCron = e.INSIGHT_DETECTORS_CRON?.trim() || '0 5 * * *';
```

Add both to the returned object, then export at the bottom beside line 388:

```ts
export const insightDetectorsEnabled = resolved.insightDetectorsEnabled;
export const insightDetectorsCron = resolved.insightDetectorsCron;
```

`0 5 * * *` is 05:00 UTC — after `detect_subscription_price_changes` at 02:00, so subscription price hikes are already recorded when `detectRecurringIncrease` builds its skip-set.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/config/env.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/config/env.ts backend/src/config/env.test.ts
git commit -m "feat(insights): add env config for the detector job"
```

---

### Task 2: Per-household detector runner

**Files:**
- Create: `backend/src/insights/runAllHouseholdDetectors.ts`
- Test: `backend/src/insights/runAllHouseholdDetectors.test.ts`

**Interfaces:**
- Consumes: `runDetectorsForHousehold(householdId: number, options?: { now?: Date; userId?: number | null }): Promise<RunDetectorsResult>` from `./runDetectors`, where `RunDetectorsResult` is `{ created: number; refreshed: number; total: number; detectorCounts: Record<string, number> }`.
- Produces: `runAllHouseholdDetectors(options?: { now?: Date; runForHousehold?: typeof runDetectorsForHousehold }): Promise<AllHouseholdDetectorsResult>` where `AllHouseholdDetectorsResult` is `{ households: number; succeeded: number; failed: number; created: number; refreshed: number; errors: Array<{ householdId: number; message: string }> }`.

The `runForHousehold` option is the test seam — unit tests inject a stub instead of exercising the full detector stack, which `runInsightDetectors.test.ts` already covers.

- [ ] **Step 1: Write the failing test**

Create `backend/src/insights/runAllHouseholdDetectors.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { Household } from '../models';
import { runAllHouseholdDetectors } from './runAllHouseholdDetectors';

test('runs detectors for every household and aggregates counts', async () => {
  const a = await Household.create({ name: 'A' });
  const b = await Household.create({ name: 'B' });
  const seen: number[] = [];

  const result = await runAllHouseholdDetectors({
    runForHousehold: async (householdId) => {
      seen.push(householdId);
      return { created: 2, refreshed: 1, total: 3, detectorCounts: {} };
    },
  });

  assert.deepEqual(seen.sort((x, y) => x - y), [a.id, b.id].sort((x, y) => x - y));
  assert.equal(result.households, 2);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.created, 4);
  assert.equal(result.refreshed, 2);
  assert.deepEqual(result.errors, []);
});

test('one household failing does not abort the others', async () => {
  const a = await Household.create({ name: 'A' });
  const b = await Household.create({ name: 'B' });

  const result = await runAllHouseholdDetectors({
    runForHousehold: async (householdId) => {
      if (householdId === a.id) throw new Error('boom');
      return { created: 1, refreshed: 0, total: 1, detectorCounts: {} };
    },
  });

  assert.equal(result.households, 2);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.created, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].householdId, a.id);
  assert.match(result.errors[0].message, /boom/);
});
```

If `Household.create` needs more required columns than `name`, read `backend/src/models/Household.ts` and supply them.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/insights/runAllHouseholdDetectors.test.ts`
Expected: FAIL — cannot find module `./runAllHouseholdDetectors`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/insights/runAllHouseholdDetectors.ts`:

```ts
/**
 * Fans the insight detectors out across every household.
 *
 * `runDetectorsForHousehold` is per-household, so the scheduled job needs a
 * wrapper that iterates. Failures are isolated per household: one bad row
 * must not stop the remaining households from getting fresh insights.
 */
import { Household } from '../models';
import { logger } from '../observability/logger';
import { runDetectorsForHousehold } from './runDetectors';

export interface AllHouseholdDetectorsResult {
  households: number;
  succeeded: number;
  failed: number;
  created: number;
  refreshed: number;
  errors: Array<{ householdId: number; message: string }>;
}

export async function runAllHouseholdDetectors(options?: {
  now?: Date;
  /** Test seam — defaults to the real per-household runner. */
  runForHousehold?: typeof runDetectorsForHousehold;
}): Promise<AllHouseholdDetectorsResult> {
  const now = options?.now ?? new Date();
  const runOne = options?.runForHousehold ?? runDetectorsForHousehold;

  const households = await Household.findAll({ attributes: ['id'], raw: true });

  const result: AllHouseholdDetectorsResult = {
    households: households.length,
    succeeded: 0,
    failed: 0,
    created: 0,
    refreshed: 0,
    errors: [],
  };

  for (const row of households as unknown as Array<{ id: number }>) {
    try {
      const one = await runOne(row.id, { now });
      result.succeeded += 1;
      result.created += one.created;
      result.refreshed += one.refreshed;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      result.failed += 1;
      result.errors.push({ householdId: row.id, message });
      logger.warn(
        { householdId: row.id, err: message },
        'insight_detectors_household_failed',
      );
    }
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/insights/runAllHouseholdDetectors.test.ts`
Expected: PASS — both tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/insights/runAllHouseholdDetectors.ts backend/src/insights/runAllHouseholdDetectors.test.ts
git commit -m "feat(insights): fan detector runs across households with per-household error isolation"
```

---

### Task 3: Register the job

**Files:**
- Create: `backend/src/jobs/definitions/runInsightDetectors.ts`
- Modify: `backend/src/server.ts:22` (add an import beside the existing job imports)

**Interfaces:**
- Consumes: `runAllHouseholdDetectors` (Task 2); `env.insightDetectorsCron`, `env.insightDetectorsEnabled` (Task 1); `defineJob(def: { name: string; cronDefault: string; enabledDefault: boolean; handler: JobHandler }): void` from `../registry`.
- Produces: a registered job named `run_insight_detectors`.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/jobs/registry.test.ts`:

```ts
test('run_insight_detectors is registered', async () => {
  await import('./definitions/runInsightDetectors');
  const names = listDefinitions().map((d) => d.name);
  assert.ok(names.includes('run_insight_detectors'));
});
```

Use the file's existing import of `listDefinitions`; add one if absent.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/jobs/registry.test.ts`
Expected: FAIL — cannot find module `./definitions/runInsightDetectors`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/jobs/definitions/runInsightDetectors.ts`:

```ts
/**
 * Scheduled insight-detector run.
 *
 * The eight detectors in `src/insights/detectors` previously ran only when a
 * user pressed the button behind POST /api/insights/run, so the insights page
 * showed whatever was found the last time somebody clicked. 05:00 UTC puts
 * this after detect_subscription_price_changes (02:00) so subscription price
 * hikes are already recorded when detectRecurringIncrease builds its skip-set.
 */
import { defineJob } from '../registry';
import { runAllHouseholdDetectors } from '../../insights/runAllHouseholdDetectors';
import * as env from '../../config/env';

defineJob({
  name: 'run_insight_detectors',
  cronDefault: env.insightDetectorsCron,
  enabledDefault: env.insightDetectorsEnabled,
  handler: async () => {
    const summary = await runAllHouseholdDetectors();
    return { summary };
  },
});
```

In `backend/src/server.ts`, beside line 22:

```ts
import './jobs/definitions/runInsightDetectors';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/jobs/registry.test.ts`
Expected: PASS

Then: `yarn workspace cashflow-backend run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/jobs/definitions/runInsightDetectors.ts backend/src/server.ts backend/src/jobs/registry.test.ts
git commit -m "feat(insights): run the detectors on a daily schedule

The eight detectors had no job definition; their only caller was the
manual POST /api/insights/run. Production insight rows had not refreshed
since 2026-05-26 as a result."
```

---

# Part 2 — Fold the forked insight engine

### Task 4: Insight → action-item mapper

**Files:**
- Create: `backend/src/insights/toActionItems.ts`
- Test: `backend/src/insights/toActionItems.test.ts`

**Interfaces:**
- Consumes: `Insight` model (`backend/src/models/Insight.ts`) with fields `id`, `type`, `severity: 'info' | 'warning' | 'critical'`, `title`, `description: string | null`, `entityType: string | null`, `entityId: number | null`, `status`, `metadata: unknown`; `CfoBriefingActionItem` and `CfoBriefingActionItemSeverity` from `../models/CfoBriefing`.
- Produces:
  - `mapInsightSeverity(s: 'info' | 'warning' | 'critical'): CfoBriefingActionItemSeverity`
  - `supportingIdsFromMetadata(metadata: unknown): number[]`
  - `insightToActionItem(row: InsightLike): CfoBriefingActionItem`
  - `type InsightLike = { id: number; type: string; severity: 'info' | 'warning' | 'critical'; title: string; description: string | null; entityType: string | null; entityId: number | null; metadata: unknown }`

- [ ] **Step 1: Write the failing test**

Create `backend/src/insights/toActionItems.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapInsightSeverity,
  supportingIdsFromMetadata,
  insightToActionItem,
} from './toActionItems';

test('severity mapping is total over the Insight severities', () => {
  assert.equal(mapInsightSeverity('info'), 'info');
  assert.equal(mapInsightSeverity('warning'), 'watch');
  assert.equal(mapInsightSeverity('critical'), 'action');
});

test('supporting ids come from metadata.transactionIds when present', () => {
  assert.deepEqual(supportingIdsFromMetadata({ transactionIds: [3, 1, 2] }), [3, 1, 2]);
  assert.deepEqual(supportingIdsFromMetadata({ transactionIds: [1, 'x', 2] }), [1, 2]);
  assert.deepEqual(supportingIdsFromMetadata(null), []);
  assert.deepEqual(supportingIdsFromMetadata({}), []);
  assert.deepEqual(supportingIdsFromMetadata('nope'), []);
});

test('maps an insight row into a briefing action item', () => {
  const item = insightToActionItem({
    id: 42,
    type: 'duplicate_transactions',
    severity: 'warning',
    title: 'Possible duplicate charge from Loblaws',
    description: '2 charges of $50.00 at Loblaws within 3 days.',
    entityType: 'transaction',
    entityId: 900,
    metadata: { transactionIds: [900, 901] },
  });

  assert.equal(item.id, 'insight-42');
  assert.equal(item.type, 'anomaly');
  assert.equal(item.severity, 'watch');
  assert.equal(item.title, 'Possible duplicate charge from Loblaws');
  assert.equal(item.summary, '2 charges of $50.00 at Loblaws within 3 days.');
  assert.equal(item.status, 'open');
  assert.equal(item.refType, 'transaction');
  assert.equal(item.refId, 900);
  assert.deepEqual(item.supportingTransactionIds, [900, 901]);
  assert.equal(item.link, '/insights');
});

test('falls back to the title when an insight has no description', () => {
  const item = insightToActionItem({
    id: 7,
    type: 'cash_runway_low',
    severity: 'critical',
    title: 'Cash runway is short',
    description: null,
    entityType: null,
    entityId: null,
    metadata: null,
  });

  assert.equal(item.summary, 'Cash runway is short');
  assert.equal(item.severity, 'action');
  assert.equal(item.refType, null);
  assert.equal(item.refId, null);
  assert.deepEqual(item.supportingTransactionIds, []);
});

test('an unrecognised entityType does not become an invalid refType', () => {
  const item = insightToActionItem({
    id: 8,
    type: 'settlement_imbalance',
    severity: 'info',
    title: 'Settlement imbalance',
    description: 'You are owed $120.',
    entityType: 'contact',
    entityId: 5,
    metadata: null,
  });

  assert.equal(item.refType, null);
  assert.equal(item.refId, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/insights/toActionItems.test.ts`
Expected: FAIL — cannot find module `./toActionItems`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/insights/toActionItems.ts`:

```ts
/**
 * Maps persisted `Insight` rows onto `CfoBriefingActionItem`s.
 *
 * The CFO briefing and the AI review both used to build their "anomaly" items
 * from `ai/insights.ts`, a second insight engine that emitted six fixed
 * templates and never saw the real detectors. Both now read `Insight` rows,
 * and this module owns the single mapping between the two shapes.
 *
 * Note the two severity vocabularies: `Insight.severity` is
 * info|warning|critical, `CfoBriefingActionItemSeverity` is info|watch|action.
 */
import type {
  CfoBriefingActionItem,
  CfoBriefingActionItemRefType,
  CfoBriefingActionItemSeverity,
} from '../models/CfoBriefing';
import type { InsightSeverity } from '../models/Insight';

export type InsightLike = {
  id: number;
  type: string;
  severity: InsightSeverity;
  title: string;
  description: string | null;
  entityType: string | null;
  entityId: number | null;
  metadata: unknown;
};

export function mapInsightSeverity(s: InsightSeverity): CfoBriefingActionItemSeverity {
  if (s === 'critical') return 'action';
  if (s === 'warning') return 'watch';
  return 'info';
}

/**
 * Several detectors put the transactions behind a finding in
 * `metadata.transactionIds` (see detectDuplicateTransactions). Anything else
 * yields an empty list rather than a partial one.
 */
export function supportingIdsFromMetadata(metadata: unknown): number[] {
  if (metadata == null || typeof metadata !== 'object') return [];
  const raw = (metadata as { transactionIds?: unknown }).transactionIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

/** `CfoBriefingActionItemRefType` is a closed union; anything else is dropped. */
const REF_TYPES = new Set(['transaction', 'event', 'rule', 'subscription', 'import']);

function refTypeFrom(entityType: string | null): CfoBriefingActionItemRefType {
  return entityType && REF_TYPES.has(entityType)
    ? (entityType as CfoBriefingActionItemRefType)
    : null;
}

export function insightToActionItem(row: InsightLike): CfoBriefingActionItem {
  const refType = refTypeFrom(row.entityType);
  return {
    id: `insight-${row.id}`,
    type: 'anomaly',
    refType,
    refId: refType == null ? null : row.entityId,
    severity: mapInsightSeverity(row.severity),
    title: row.title,
    summary: row.description ?? row.title,
    status: 'open',
    supportingTransactionIds: supportingIdsFromMetadata(row.metadata),
    rationale: `Detected by the ${row.type} insight detector.`,
    link: '/insights',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/insights/toActionItems.test.ts`
Expected: PASS — all five tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/insights/toActionItems.ts backend/src/insights/toActionItems.test.ts
git commit -m "feat(insights): map Insight rows onto briefing action items"
```

---

### Task 5: Briefing reads real detector output

**Files:**
- Modify: `backend/src/cfo/briefingBuilder.ts` (imports; the `insightsOut` entry in the `Promise.all` at ~line 237; the anomaly block at ~line 300)
- Test: `backend/src/cfo/cfoBriefingBuilder.test.ts`

**Interfaces:**
- Consumes: `insightToActionItem`, `InsightLike` (Task 4).
- Produces: `buildCfoBriefing` keeps its existing signature and `BuildBriefingResult` shape.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/cfo/cfoBriefingBuilder.test.ts`:

```ts
import { Insight } from '../models';
import { loadOpenInsightItems } from './briefingBuilder';

test('loadOpenInsightItems returns open insights as anomaly action items', async () => {
  const householdId = 1;
  await Insight.create({
    householdId,
    userId: null,
    type: 'merchant_spend_spike',
    severity: 'warning',
    title: 'Spending at Loblaws is up',
    description: 'Up 3x versus the prior three months.',
    entityType: null,
    entityId: null,
    status: 'open',
    fingerprint: 'spike:loblaws:2026-09',
    metadata: { transactionIds: [11, 12] },
    detectedAt: new Date(),
  });
  await Insight.create({
    householdId,
    userId: null,
    type: 'missing_receipt',
    severity: 'info',
    title: 'Dismissed already',
    description: null,
    entityType: null,
    entityId: null,
    status: 'dismissed',
    fingerprint: 'receipt:dismissed',
    metadata: null,
    detectedAt: new Date(),
  });

  const items = await loadOpenInsightItems(householdId);

  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Spending at Loblaws is up');
  assert.equal(items[0].type, 'anomaly');
  assert.equal(items[0].severity, 'watch');
  assert.deepEqual(items[0].supportingTransactionIds, [11, 12]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/cfo/cfoBriefingBuilder.test.ts`
Expected: FAIL — `loadOpenInsightItems` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/cfo/briefingBuilder.ts`, remove the `buildFinancialInsights` / `AiFinancialInsight` import and the now-unused `severityFromInsight` helper. Add:

```ts
import { Insight } from '../models';
import { insightToActionItem, type InsightLike } from '../insights/toActionItems';
```

Add the exported loader:

```ts
/**
 * Open insights for the household, as briefing action items. Exported so the
 * unit test can exercise the query without building a whole briefing.
 */
export async function loadOpenInsightItems(
  householdId: number,
): Promise<CfoBriefingActionItem[]> {
  const rows = await Insight.findAll({
    where: { householdId, status: 'open' },
    attributes: [
      'id',
      'type',
      'severity',
      'title',
      'description',
      'entityType',
      'entityId',
      'metadata',
    ],
    order: [['detectedAt', 'DESC']],
    raw: true,
  });
  return (rows as unknown as InsightLike[]).map(insightToActionItem);
}
```

In the `Promise.all`, replace the `buildFinancialInsights(...)` entry with:

```ts
    safeBriefingFetch(() => loadOpenInsightItems(householdId)),
```

Replace the anomaly block (step 2 in `buildCfoBriefing`) with:

```ts
  // 2. Anomalies from the insight detectors.
  if (insightsOut) {
    items.push(...insightsOut);
  }
```

The destructured name `insightsOut` now holds `CfoBriefingActionItem[] | null`.

Delete the inline "missing receipts on big-ticket spend" block (step 4) and its `MISSING_RECEIPT_AMOUNT_THRESHOLD` constant, plus the `txnsInWindow` query and the now-unused `Receipt` / `visibleTransactionWhere` imports if nothing else uses them. `detectMissingReceipt` already produces `missing_receipt` insights, so keeping the inline version would double-surface every one and would ignore dismissals. Drop `missingReceipts` from `BriefingCounts` and from `briefingShortSummary`, and update the existing summary test accordingly.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/cfo/cfoBriefingBuilder.test.ts`
Expected: PASS

Then: `yarn workspace cashflow-backend run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/cfo/briefingBuilder.ts backend/src/cfo/cfoBriefingBuilder.test.ts
git commit -m "feat(cfo): source briefing anomalies from the insight detectors

Also drops the inline missing-receipt scan, which duplicated the
missing_receipt detector and ignored dismissals."
```

---

### Task 6: AI review reads real detector output

**Files:**
- Modify: `backend/src/ai/reviewRunner.ts:26` (import) and `:106` (the `buildFinancialInsights` call in `Promise.all`)

**Interfaces:**
- Consumes: `loadOpenInsightItems` (Task 5).
- Produces: `buildReviewActionItems` keeps its signature.

**Note on testing:** this is a pure data-source swap. `backend/src/routes/aiReviewActionItem.test.ts` covers only the pure `updateActionItemStatus` helper and establishes no request or household fixtures, so there is nothing there to extend. The mapping logic this task depends on is already unit-tested in Task 4, and `buildReviewActionItems` requires a live `req` plus DB rows, which belongs in the integration suite rather than a colocated unit test. Verification here is typecheck plus the existing suites. Do not fabricate a unit test for it.

- [ ] **Step 1: Confirm the current behaviour is what you think it is**

Run: `grep -n "buildFinancialInsights" backend/src/ai/reviewRunner.ts`
Expected: two matches — the import at line 26 and the call at line 106.

- [ ] **Step 2: Make the change**

In `backend/src/ai/reviewRunner.ts`, replace the import at line 26:

```ts
import { loadOpenInsightItems } from '../cfo/briefingBuilder';
```

and the `Promise.all` entry at line 106:

```ts
      loadOpenInsightItems(householdId),
```

Then adapt the block that consumed `insightsOut.insights` to push the returned action items directly, matching the change made in Task 5. Note that `AiReviewActionItem.status` uses `'suggested'` where `CfoBriefingActionItem.status` uses `'open'` — check `backend/src/models/AiReviewRun.ts` and remap the status when pushing, rather than assuming the two item types are interchangeable.

- [ ] **Step 3: Verify**

Run: `grep -n "buildFinancialInsights" backend/src/ai/reviewRunner.ts`
Expected: no matches.

Run: `yarn workspace cashflow-backend run typecheck`
Expected: no errors.

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/routes/aiReviewActionItem.test.ts`
Expected: PASS — unchanged, since it exercises only the pure status helper.

- [ ] **Step 4: Commit**

```bash
git add backend/src/ai/reviewRunner.ts
git commit -m "feat(ai): source review anomalies from the insight detectors"
```

---

### Task 7: Repoint the Unified Inbox and delete the forked engine

**Files:**
- Modify: `backend/src/routes/ai.ts` — delete `GET /insights` (~line 283–340), `supersedeFinancialInsightDupes`, and `summarizeInsight` (line 451); repoint `/inbox` (line 507) and `/inbox/count` (line 600)
- Delete: `backend/src/ai/insights.ts`, `backend/src/ai/insightsNoCategory.test.ts`
- Modify: `backend/test/integration/aiInbox.test.ts` — the `financial_insight` cases at lines 72, 82, 95, 102, 112, 117, 125, 153, 182, 317
- Test: `frontend/src/pages/UnifiedInboxPage.test.tsx` must still pass

**Interfaces:**
- Consumes: `Insight` model; `mapInsightSeverity` (Task 4).
- Produces: `/api/ai/inbox` and `/api/ai/inbox/count` keep their response shapes. The `financial_insight` `InboxItem.id` becomes the `Insight` row id.

**This task rewrites existing tests rather than adding one.** `backend/test/integration/aiInbox.test.ts` seeds `AiSuggestion` rows with `kind: 'financial_insight'` and asserts `byKind.financial_insight`. Those assertions encode the behaviour being replaced, so they must be rewritten to seed `Insight` rows. That suite needs Postgres and `TEST_DATABASE_URL`; run it with `yarn workspace cashflow-backend run test:integration`.

Note that `Insight` has no `status: 'suggested'` or `'superseded'` — its lifecycle is `open | dismissed | resolved`. The existing test at line 95 seeds a `superseded` row to prove it is excluded from the count; the equivalent is a `dismissed` insight. The household-scoping cases at lines 112 and 182 carry over directly, since `Insight` has `householdId`.

- [ ] **Step 1: Rewrite the failing tests**

In `backend/test/integration/aiInbox.test.ts`, replace each `financial_insight` `AiSuggestion.create` with an `Insight.create`. The shape:

```ts
await Insight.create({
  householdId,
  userId: null,
  type: 'merchant_spend_spike',
  severity: 'warning',
  title: 'Spending at Loblaws is up',
  description: 'Up 3x versus the prior three months.',
  entityType: null,
  entityId: null,
  status: 'open',                  // was status: 'suggested'
  fingerprint: `spike:loblaws:${Date.now()}`,
  metadata: null,
  detectedAt: new Date(),
});
```

`fingerprint` is part of the upsert key, so give each seeded row a distinct one or the second create collides.

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn workspace cashflow-backend run test:integration`
Expected: FAIL — the counts still read `AiSuggestion` rows, so seeded `Insight` rows are not counted.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/routes/ai.ts`:

1. Delete the `GET /insights` route, the `buildFinancialInsights` import, `supersedeFinancialInsightDupes` and both of its call sites, and `summarizeInsight` with its local `type InsightSeverity` at line 449.
2. In `/inbox/count`, replace the `AiSuggestion.count({ ..., kind: 'financial_insight' })` entry with:

```ts
      Insight.count({ where: { householdId, status: 'open' } }),
```

3. In `/inbox`, drop `'financial_insight'` from the `AiSuggestion.findAll` `kind` array so it fetches only `transaction_audit`, delete the `else` branch that built `financial_insight` items, and add a parallel query plus mapping:

```ts
      Insight.findAll({
        where: { householdId, status: 'open' },
        attributes: ['id', 'type', 'severity', 'title', 'description', 'detectedAt'],
        order: [['detectedAt', 'DESC']],
        limit,
        raw: true,
      }),
```

```ts
    const insightItems: InboxItem[] = (insightRows as unknown as Array<{
      id: number;
      type: string;
      severity: 'info' | 'warning' | 'critical';
      title: string;
      description: string | null;
      detectedAt: Date;
    }>).map((row) => ({
      id: row.id,
      kind: 'financial_insight',
      createdAt: new Date(row.detectedAt).toISOString(),
      transactionId: null,
      summary: row.description ?? row.title,
      severity: mapInsightSeverity(row.severity),
      confidence: null,
      output: { type: row.type, title: row.title, description: row.description },
    }));
```

Import `Insight` from `../models` and `mapInsightSeverity` from `../insights/toActionItems`. Include `insightItems` wherever the route assembles its final list.

`householdId` is already computed in both handlers as `isSuperadmin(req) ? null : currentAuth(req).household.id`. Both new queries need a real household id — when it is `null`, keep today's superadmin behaviour by omitting the household filter.

4. Delete `backend/src/ai/insights.ts` and `backend/src/ai/insightsNoCategory.test.ts`.

Leave existing `AiSuggestion` rows with `kind = 'financial_insight'` in place and keep the value in the `AiSuggestionKind` union — they are historical records and must still deserialize.

- [ ] **Step 4: Run test to verify it passes**

```bash
grep -rn "buildFinancialInsights\|ai/insights" backend/src frontend/src
```
Expected: no matches.

Run: `yarn workspace cashflow-backend run typecheck`
Expected: no errors.

Run: `yarn test`
Expected: PASS, including `frontend/src/pages/UnifiedInboxPage.test.tsx`.

Run: `yarn workspace cashflow-backend run test:integration`
Expected: PASS — requires Postgres and `TEST_DATABASE_URL`.

- [ ] **Step 5: Commit**

```bash
git add -A backend/src/routes/ai.ts backend/src/ai backend/test/integration/aiInbox.test.ts frontend/src
git commit -m "refactor(ai): fold the six-template insight engine into the detectors

The Unified Inbox read AiSuggestion rows written by GET /api/ai/insights
while the insights page read Insight rows, so dismissing an insight left
the inbox badge unchanged. Both now read Insight."
```

---

# Part 3 — Briefing synthesis

### Task 8: Synthesis parser

**Files:**
- Create: `backend/src/cfo/synthesizeBriefing.ts`
- Test: `backend/src/cfo/synthesizeBriefing.test.ts`

**Interfaces:**
- Consumes: `CfoBriefingActionItem`, `CfoBriefingSafeToSpendSnapshot` from `../models/CfoBriefing`; `openaiJson` from `../ai/openaiJson`; `getOpenAiConfig` from `../config/openai`; `logger` from `../observability/logger`.
- Produces:
  - `parseSynthesis(raw: Record<string, unknown>, items: CfoBriefingActionItem[]): { summary: string | null; ordered: CfoBriefingActionItem[] }`
  - `synthesizeBriefing(args: { items: CfoBriefingActionItem[]; safeToSpend: CfoBriefingSafeToSpendSnapshot | null; currency: string; openaiJsonImpl?: typeof openaiJson }): Promise<{ summary: string | null; ordered: CfoBriefingActionItem[] }>`

`openaiJsonImpl` is the test seam — no unit test may reach the network.

- [ ] **Step 1: Write the failing test**

Create `backend/src/cfo/synthesizeBriefing.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CfoBriefingActionItem } from '../models/CfoBriefing';
import { parseSynthesis, synthesizeBriefing } from './synthesizeBriefing';

function item(id: string, title: string): CfoBriefingActionItem {
  return {
    id,
    type: 'anomaly',
    refType: null,
    refId: null,
    severity: 'info',
    title,
    summary: title,
    status: 'open',
  };
}

const items = [item('a', 'A'), item('b', 'B'), item('c', 'C')];

test('reorders items by the returned ranking', () => {
  const out = parseSynthesis(
    { summary: 'Two things need you.', ranking: [{ id: 'c' }, { id: 'a' }] },
    items,
  );
  assert.equal(out.summary, 'Two things need you.');
  assert.deepEqual(out.ordered.map((i) => i.id), ['c', 'a', 'b']);
});

test('drops ranking entries for ids not in the input', () => {
  const out = parseSynthesis(
    { summary: 'x', ranking: [{ id: 'ghost' }, { id: 'b' }] },
    items,
  );
  assert.deepEqual(out.ordered.map((i) => i.id), ['b', 'a', 'c']);
});

test('a duplicated id is used once', () => {
  const out = parseSynthesis(
    { summary: 'x', ranking: [{ id: 'b' }, { id: 'b' }, { id: 'a' }] },
    items,
  );
  assert.deepEqual(out.ordered.map((i) => i.id), ['b', 'a', 'c']);
});

test('a missing or blank summary yields null, not an empty string', () => {
  assert.equal(parseSynthesis({ ranking: [] }, items).summary, null);
  assert.equal(parseSynthesis({ summary: '   ' }, items).summary, null);
  assert.equal(parseSynthesis({ summary: 42 }, items).summary, null);
});

test('a malformed ranking leaves the original order', () => {
  const out = parseSynthesis({ summary: 'x', ranking: 'nope' }, items);
  assert.deepEqual(out.ordered.map((i) => i.id), ['a', 'b', 'c']);
});

test('synthesizeBriefing degrades to nulls when the model throws', async () => {
  const out = await synthesizeBriefing({
    items,
    safeToSpend: null,
    currency: 'CAD',
    openaiJsonImpl: async () => {
      throw new Error('502 Bad Gateway');
    },
  });
  assert.equal(out.summary, null);
  assert.deepEqual(out.ordered.map((i) => i.id), ['a', 'b', 'c']);
});

test('synthesizeBriefing returns the original order for an empty item list', async () => {
  let called = false;
  const out = await synthesizeBriefing({
    items: [],
    safeToSpend: null,
    currency: 'CAD',
    openaiJsonImpl: async () => {
      called = true;
      return {};
    },
  });
  assert.equal(called, false);
  assert.equal(out.summary, null);
  assert.deepEqual(out.ordered, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/cfo/synthesizeBriefing.test.ts`
Expected: FAIL — cannot find module `./synthesizeBriefing`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/cfo/synthesizeBriefing.ts`:

```ts
/**
 * LLM synthesis pass over the briefing's deterministic action items.
 *
 * The items themselves stay deterministic — the model may only order them and
 * write a narrative over them. It never sees raw transactions and never
 * supplies a figure, so it has no way to invent one. Any ranking entry naming
 * an id we did not send is dropped.
 *
 * Follows the degradation contract already used by routes/reports.ts
 * `maybeBuildAiSummary`: no key or any failure returns nulls and the caller
 * keeps its deterministic output.
 */
import type {
  CfoBriefingActionItem,
  CfoBriefingSafeToSpendSnapshot,
} from '../models/CfoBriefing';
import { getOpenAiConfig } from '../config/openai';
import { openaiJson } from '../ai/openaiJson';
import { logger } from '../observability/logger';

export const CFO_BRIEFING_SYNTHESIS_PROMPT_VERSION = 'cfo-briefing-v2';

export interface SynthesisResult {
  summary: string | null;
  ordered: CfoBriefingActionItem[];
}

export function parseSynthesis(
  raw: Record<string, unknown>,
  items: CfoBriefingActionItem[],
): SynthesisResult {
  const summary =
    typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim() : null;

  const byId = new Map(items.map((i) => [i.id, i]));
  const ordered: CfoBriefingActionItem[] = [];
  const used = new Set<string>();

  if (Array.isArray(raw.ranking)) {
    for (const entry of raw.ranking) {
      const id =
        entry && typeof entry === 'object'
          ? (entry as { id?: unknown }).id
          : undefined;
      if (typeof id !== 'string') continue;
      if (used.has(id)) continue;
      const match = byId.get(id);
      if (!match) continue; // fabricated id — drop it
      used.add(id);
      ordered.push(match);
    }
  }

  // Anything the model omitted keeps its original relative order, after the
  // ranked items.
  for (const i of items) {
    if (!used.has(i.id)) ordered.push(i);
  }

  return { summary, ordered };
}

const SYSTEM_PROMPT = [
  'You are a household CFO writing a short briefing.',
  'You receive a JSON list of action items that were computed deterministically, plus an optional safe-to-spend snapshot.',
  'Write a 2-4 sentence plain-English summary of what needs attention, and rank the items by what the household should deal with first.',
  'Refer only to figures that appear in the input. Never introduce a number that is not there.',
  'Never invent an item id. Only use ids present in the input.',
  'Return strict JSON: { "summary": "...", "ranking": [{ "id": "...", "why": "..." }] }.',
].join(' ');

export async function synthesizeBriefing(args: {
  items: CfoBriefingActionItem[];
  safeToSpend: CfoBriefingSafeToSpendSnapshot | null;
  currency: string;
  /** Test seam — defaults to the real client. */
  openaiJsonImpl?: typeof openaiJson;
}): Promise<SynthesisResult> {
  const { items, safeToSpend, currency } = args;
  if (items.length === 0) return { summary: null, ordered: [] };

  const call = args.openaiJsonImpl ?? openaiJson;
  if (!args.openaiJsonImpl && !getOpenAiConfig()) {
    return { summary: null, ordered: items };
  }

  try {
    const payload = {
      currency,
      safeToSpend,
      items: items.map((i) => ({
        id: i.id,
        type: i.type,
        severity: i.severity,
        title: i.title,
        summary: i.summary,
      })),
    };
    const raw = await call([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(payload) },
    ]);
    return parseSynthesis(raw, items);
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'cfo_briefing_synthesis_failed',
    );
    return { summary: null, ordered: items };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/cfo/synthesizeBriefing.test.ts`
Expected: PASS — all seven tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/cfo/synthesizeBriefing.ts backend/src/cfo/synthesizeBriefing.test.ts
git commit -m "feat(cfo): add briefing synthesis pass with fabricated-id rejection"
```

---

### Task 9: Wire synthesis into the briefing

**Files:**
- Modify: `backend/src/cfo/briefingBuilder.ts` — the return block of `buildCfoBriefing`, and `CFO_BRIEFING_PROMPT_VERSION`
- Test: `backend/src/cfo/cfoBriefingBuilder.test.ts`

**Interfaces:**
- Consumes: `synthesizeBriefing`, `CFO_BRIEFING_SYNTHESIS_PROMPT_VERSION` (Task 8).
- Produces: `BuildBriefingResult` gains no new fields — `summary` is now the narrative when available, and `actionItems` are reordered. `BuildBriefingParams` gains an optional `synthesizeImpl?: typeof synthesizeBriefing` test seam.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/cfo/cfoBriefingBuilder.test.ts`:

```ts
test('briefing uses the synthesized summary and ordering when available', async () => {
  const result = await buildCfoBriefing({
    req: makeReq(),            // reuse this file's existing request helper
    householdId: 1,
    userId: 1,
    periodStart: '2026-09-01',
    periodEnd: '2026-09-07',
    currency: 'CAD',
    synthesizeImpl: async ({ items }) => ({
      summary: 'One thing matters this week.',
      ordered: [...items].reverse(),
    }),
  });

  assert.equal(result.summary, 'One thing matters this week.');
});

test('briefing falls back to the count summary when synthesis returns null', async () => {
  const result = await buildCfoBriefing({
    req: makeReq(),
    householdId: 1,
    userId: 1,
    periodStart: '2026-09-01',
    periodEnd: '2026-09-07',
    currency: 'CAD',
    synthesizeImpl: async ({ items }) => ({ summary: null, ordered: items }),
  });

  assert.match(result.summary, /action item|All clear/);
});
```

Use whatever request helper the file already defines; if it has none, build a minimal `Request`-shaped stub matching what `visibleTransactionWhere` and `householdWhere` read.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/cfo/cfoBriefingBuilder.test.ts`
Expected: FAIL — `synthesizeImpl` is not accepted by `BuildBriefingParams`.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/cfo/briefingBuilder.ts`:

```ts
import { synthesizeBriefing } from './synthesizeBriefing';
```

Bump the version constant:

```ts
export const CFO_BRIEFING_PROMPT_VERSION = 'cfo-briefing-v2';
```

Add the seam to `BuildBriefingParams`:

```ts
  /** Test seam — defaults to the real synthesis pass. */
  synthesizeImpl?: typeof synthesizeBriefing;
```

Replace the final `return` of `buildCfoBriefing` with:

```ts
  const fallbackSummary = briefingShortSummary(counts);
  const synthesize = params.synthesizeImpl ?? synthesizeBriefing;
  const synthesis = await synthesize({
    items,
    safeToSpend: safeToSpendSnapshot,
    currency,
  });

  return {
    actionItems: synthesis.ordered,
    summary: synthesis.summary ?? fallbackSummary,
    safeToSpendSnapshot,
  };
```

`synthesizeBriefing` already swallows its own failures, so no extra guard is needed here.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/cfo/cfoBriefingBuilder.test.ts`
Expected: PASS

Then: `yarn workspace cashflow-backend run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/cfo/briefingBuilder.ts backend/src/cfo/cfoBriefingBuilder.test.ts
git commit -m "feat(cfo): narrate and rank the briefing instead of tallying it

briefingShortSummary becomes the fallback rather than the only path."
```

---

# Part 4 — Correction feedback

### Task 10: Past-corrections query

**Files:**
- Modify: `backend/src/ai/merchantMemory.ts:23` — export `normalizeMerchantKey`
- Create: `backend/src/ai/pastCorrections.ts`
- Test: `backend/src/ai/pastCorrections.test.ts`

**Interfaces:**
- Consumes: `AiSuggestion` model; `normalizeMerchantKey(value: string): string`.
- Produces:
  - `type CorrectionFields = { category: string | null; business: boolean | null; splitType: string | null }`
  - `type PastCorrection = { suggestionId: number; suggested: CorrectionFields; corrected: CorrectionFields; mismatchedFields: string[] }`
  - `findPastCorrections(householdId: number | null | undefined, merchant: string | null, limit?: number): Promise<PastCorrection[]>` — default limit 5.

- [ ] **Step 1: Write the failing test**

Create `backend/src/ai/pastCorrections.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { AiSuggestion } from '../models';
import { findPastCorrections } from './pastCorrections';

async function seed(overrides: Record<string, unknown>) {
  return AiSuggestion.create({
    householdId: 1,
    kind: 'transaction_fields',
    status: 'edited',
    inputSnapshot: { transaction: { merchantClean: 'STARBUCKS #123' } },
    output: { category: 'Dining', business: false, splitType: 'me' },
    finalSnapshot: {
      category: 'Groceries',
      business: false,
      splitType: 'me',
      metrics: { categoryMatch: false, businessMatch: true, splitTypeMatch: true },
    },
    ...overrides,
  } as never);
}

test('returns edited suggestions for the same normalized merchant', async () => {
  await seed({});
  const out = await findPastCorrections(1, 'Starbucks 123');
  assert.equal(out.length, 1);
  assert.equal(out[0].suggested.category, 'Dining');
  assert.equal(out[0].corrected.category, 'Groceries');
  assert.deepEqual(out[0].mismatchedFields, ['category']);
});

test('ignores accepted suggestions', async () => {
  await seed({ status: 'accepted' });
  assert.deepEqual(await findPastCorrections(1, 'Starbucks 123'), []);
});

test('ignores other merchants', async () => {
  await seed({});
  assert.deepEqual(await findPastCorrections(1, 'Loblaws'), []);
});

test('ignores other households', async () => {
  await seed({ householdId: 2 });
  assert.deepEqual(await findPastCorrections(1, 'Starbucks 123'), []);
});

test('returns an empty list for a null merchant', async () => {
  await seed({});
  assert.deepEqual(await findPastCorrections(1, null), []);
});

test('caps the number of corrections returned', async () => {
  for (let i = 0; i < 8; i++) await seed({});
  const out = await findPastCorrections(1, 'Starbucks 123');
  assert.equal(out.length, 5);
});
```

Check `backend/src/models/AiSuggestion.ts` for required columns and add any the create call needs.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/ai/pastCorrections.test.ts`
Expected: FAIL — cannot find module `./pastCorrections`.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/ai/merchantMemory.ts`, change line 23 to `export function normalizeMerchantKey(...)`.

Create `backend/src/ai/pastCorrections.ts`:

```ts
/**
 * Past user corrections for a merchant, for use as few-shot negatives.
 *
 * `suggestionStore.ts` scores every suggestion against what the user finally
 * chose and persists status='edited' plus per-field mismatch booleans. That is
 * a labeled record of what the model gets wrong on this household's merchants,
 * and until now nothing read it back into a prompt.
 */
import { Op } from 'sequelize';
import { AiSuggestion } from '../models';
import { normalizeMerchantKey } from './merchantMemory';

export interface CorrectionFields {
  category: string | null;
  business: boolean | null;
  splitType: string | null;
}

export interface PastCorrection {
  suggestionId: number;
  suggested: CorrectionFields;
  corrected: CorrectionFields;
  mismatchedFields: string[];
}

const METRIC_TO_FIELD: Record<string, string> = {
  categoryMatch: 'category',
  businessMatch: 'business',
  splitTypeMatch: 'splitType',
  pctMeMatch: 'pctMe',
  pctPartnerMatch: 'pctPartner',
};

function fields(source: unknown): CorrectionFields {
  const o = (source ?? {}) as Record<string, unknown>;
  return {
    category: typeof o.category === 'string' ? o.category : null,
    business: typeof o.business === 'boolean' ? o.business : null,
    splitType: typeof o.splitType === 'string' ? o.splitType : null,
  };
}

function mismatchedFrom(finalSnapshot: unknown): string[] {
  const metrics = (finalSnapshot as { metrics?: Record<string, unknown> } | null)
    ?.metrics;
  if (!metrics || typeof metrics !== 'object') return [];
  const out: string[] = [];
  for (const [metric, field] of Object.entries(METRIC_TO_FIELD)) {
    if (metrics[metric] === false) out.push(field);
  }
  return out;
}

export async function findPastCorrections(
  householdId: number | null | undefined,
  merchant: string | null,
  limit = 5,
): Promise<PastCorrection[]> {
  if (!merchant || !merchant.trim()) return [];
  const key = normalizeMerchantKey(merchant);
  if (!key) return [];

  // The merchant lives inside the JSON input snapshot, and JSON extraction
  // differs between SQLite and Postgres — so filter in JS over a bounded
  // recent window rather than in SQL.
  const rows = await AiSuggestion.findAll({
    where: {
      kind: 'transaction_fields',
      status: 'edited',
      ...(householdId != null ? { householdId } : {}),
      finalSnapshot: { [Op.ne]: null },
    },
    order: [['id', 'DESC']],
    limit: 200,
  });

  const out: PastCorrection[] = [];
  for (const row of rows) {
    const snapshot = row.inputSnapshot as
      | { transaction?: { merchantClean?: unknown; merchantRaw?: unknown } }
      | null;
    const raw =
      typeof snapshot?.transaction?.merchantClean === 'string'
        ? snapshot.transaction.merchantClean
        : typeof snapshot?.transaction?.merchantRaw === 'string'
          ? snapshot.transaction.merchantRaw
          : null;
    if (!raw || normalizeMerchantKey(raw) !== key) continue;

    out.push({
      suggestionId: row.id,
      suggested: fields(row.output),
      corrected: fields(row.finalSnapshot),
      mismatchedFields: mismatchedFrom(row.finalSnapshot),
    });
    if (out.length >= limit) break;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/ai/pastCorrections.test.ts`
Expected: PASS — all six tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/ai/pastCorrections.ts backend/src/ai/pastCorrections.test.ts backend/src/ai/merchantMemory.ts
git commit -m "feat(ai): read back the corrections users made to past suggestions"
```

---

### Task 11: Inject corrections into the categorization prompt

**Files:**
- Modify: `backend/src/ai/suggestTransaction.ts` — `TransactionSuggestionContext`, `buildTransactionSuggestionContext`, `suggestTransactionFieldsTracked`, `TRANSACTION_SUGGESTION_PROMPT_VERSION`; delete `suggestTransactionFields`
- Modify: `backend/src/routes/transactions.ts:21` — drop the `suggestTransactionFields` import and the `:653` type reference
- Test: `backend/src/ai/aiSuggestion.test.ts`

**Interfaces:**
- Consumes: `findPastCorrections`, `PastCorrection` (Task 10).
- Produces: `TransactionSuggestionContext` gains `pastCorrections: PastCorrection[]`. `TRANSACTION_SUGGESTION_PROMPT_VERSION` becomes `'transaction-fields-v3'`. `suggestTransactionFields` no longer exists.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/ai/aiSuggestion.test.ts`:

```ts
import { buildCorrectionsPromptSection } from './suggestTransaction';

test('renders past corrections as explicit negatives', () => {
  const section = buildCorrectionsPromptSection([
    {
      suggestionId: 1,
      suggested: { category: 'Dining', business: false, splitType: 'me' },
      corrected: { category: 'Groceries', business: false, splitType: 'me' },
      mismatchedFields: ['category'],
    },
  ]);
  assert.match(section, /previously suggested/i);
  assert.match(section, /Dining/);
  assert.match(section, /Groceries/);
});

test('renders nothing when there are no corrections', () => {
  assert.equal(buildCorrectionsPromptSection([]), '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/ai/aiSuggestion.test.ts`
Expected: FAIL — `buildCorrectionsPromptSection` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/ai/suggestTransaction.ts`:

```ts
import { findPastCorrections, type PastCorrection } from './pastCorrections';
```

Bump the version:

```ts
export const TRANSACTION_SUGGESTION_PROMPT_VERSION = 'transaction-fields-v3';
```

Add to `TransactionSuggestionContext`:

```ts
  pastCorrections: PastCorrection[];
```

In `buildTransactionSuggestionContext`, add to the `Promise.all` destructuring and array:

```ts
    findPastCorrections(householdId, txn.merchantClean || txn.merchantRaw),
```

and include `pastCorrections` in the returned object.

Add the pure renderer:

```ts
/**
 * Renders past corrections as explicit negatives. Empty string when there are
 * none, so the prompt has no dangling empty section.
 */
export function buildCorrectionsPromptSection(corrections: PastCorrection[]): string {
  if (corrections.length === 0) return '';
  const lines = corrections.map((c) => {
    const fields = c.mismatchedFields.length
      ? ` (wrong on: ${c.mismatchedFields.join(', ')})`
      : '';
    return `- You previously suggested ${JSON.stringify(c.suggested)} for this merchant; the user corrected it to ${JSON.stringify(c.corrected)}${fields}.`;
  });
  return [
    '',
    'Corrections the user has already made on this merchant — do not repeat these mistakes:',
    ...lines,
  ].join('\n');
}
```

In `suggestTransactionFieldsTracked`, insert the section into the `user` array after the `Receipt extracts:` line:

```ts
    buildCorrectionsPromptSection(context.pastCorrections),
```

and add to the trailing guidance line:

```ts
    `When a past correction covers this merchant, follow the correction over your own instinct.`,
```

Delete `suggestTransactionFields` entirely. In `backend/src/routes/transactions.ts`, remove it from the import at line 21 and change the type reference at line 653 to `Awaited<ReturnType<typeof suggestTransactionFieldsTracked>>['suggestion']`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/ai/aiSuggestion.test.ts`
Expected: PASS

```bash
grep -rn "suggestTransactionFields\b" backend/src | grep -v Tracked
```
Expected: no matches.

Run: `yarn ci`
Expected: PASS — typecheck, all tests, both production builds.

- [ ] **Step 5: Commit**

```bash
git add backend/src/ai/suggestTransaction.ts backend/src/ai/aiSuggestion.test.ts backend/src/routes/transactions.ts
git commit -m "feat(ai): feed past corrections into the categorization prompt

Bumps the prompt version to transaction-fields-v3 so scripts/ai-eval.ts
separates the before and after accept-rate populations. Also removes the
untracked suggestTransactionFields variant, which sent a prompt with no
merchant memory, similar transactions, rule match, or receipt extracts."
```

---

## Verification

After Task 11, confirm the whole spec landed:

```bash
yarn ci
```

Then check the accept-rate baseline split by prompt version:

```bash
cd backend && yarn tsx scripts/ai-eval.ts 500
```

`byPromptVersion` should show `transaction-fields-v2` (historical) and, once
new suggestions have been reviewed, `transaction-fields-v3`. A meaningful
comparison needs a few dozen scored `v3` rows, so this is a check to run later,
not immediately.

To confirm Part 1 in production after deploy, the `run_insight_detectors` job
should appear in the jobs admin view with a `nextRunAt`, and `Insight` rows
should carry a `detected_at` from the most recent 05:00 UTC tick.
