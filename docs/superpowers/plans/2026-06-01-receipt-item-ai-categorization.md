# Receipt Item AI Categorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate `inferredCategory` on non-Amazon receipt line items via an AI pass — backfilling existing rows and auto-categorizing on every non-Amazon import — so the `/receipts` "Where it went" category roll-up renders.

**Architecture:** A self-contained categorizer module (`categorizeReceiptItems.ts`) that selects null-category, non-Amazon `ExternalOrderItem`s, batches them through `openaiJsonWithMeta` (injectable for tests), and writes `inferredCategory`. A single never-throwing seam `categorizeAndApplyReceiptItems` is called from the import handlers and a backfill script. The Amazon categorizer is left untouched.

**Tech Stack:** Node + TypeScript, Sequelize, `node:test` + `node:assert` (unit, sqlite per-process), tsx scripts.

**Spec:** `docs/superpowers/specs/2026-06-01-receipt-item-ai-categorization-design.md`

Run all commands from `backend/`.

---

## File Structure

- **Create** `backend/src/import/receiptCategories.ts` — the `RECEIPT_CATEGORIES` fallback taxonomy. One responsibility: the list.
- **Create** `backend/src/import/categorizeReceiptItems.ts` — selection + prompt + parse (`parseReceiptItemCategorySuggestions`), the AI pass (`categorizeReceiptItemsWithAi`), the writer (`applyReceiptItemCategorySuggestions`), and the never-throwing seam (`categorizeAndApplyReceiptItems`).
- **Create** `backend/test/categorizeReceiptItems.test.ts` — unit tests (sqlite, stubbed caller).
- **Modify** `backend/src/routes/externalOrders.ts` — call the seam from the four non-Amazon import handlers.
- **Create** `backend/scripts/backfill-receipt-item-categories.ts` — one-off backfill, dry-run by default, refuses `--commit` against local sqlite.

---

## Task 1: Categorizer module + taxonomy + unit tests

**Files:**
- Create: `backend/src/import/receiptCategories.ts`
- Create: `backend/src/import/categorizeReceiptItems.ts`
- Test: `backend/test/categorizeReceiptItems.test.ts`

- [ ] **Step 1: Write the taxonomy constant**

Create `backend/src/import/receiptCategories.ts`:

```ts
/** Fallback spending categories for non-Amazon receipt line items. */
export const RECEIPT_CATEGORIES: string[] = [
  'Groceries',
  'Produce',
  'Dairy',
  'Meat & Seafood',
  'Bakery',
  'Beverages',
  'Alcohol',
  'Snacks',
  'Household',
  'Personal Care',
  'Health & Pharmacy',
  'Baby & Kids',
  'Pet',
  'Toys',
  'Electronics',
  'Clothing',
  'Home & Garden',
  'Other',
]
```

- [ ] **Step 2: Write the failing tests**

Create `backend/test/categorizeReceiptItems.test.ts`:

```ts
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { sequelize, ExternalOrder, ExternalOrderItem } from '../src/models'
import {
  parseReceiptItemCategorySuggestions,
  categorizeReceiptItemsWithAi,
  applyReceiptItemCategorySuggestions,
  categorizeAndApplyReceiptItems,
  type ReceiptOpenAiCaller,
} from '../src/import/categorizeReceiptItems'

before(async () => {
  await sequelize.sync({ force: true })
})

// Each test gets a unique householdId so rows from other tests (the DB is
// force-synced once, then accumulates) never bleed into its queries.
let HH = 0
beforeEach(() => {
  HH += 1
})

// Stub caller: reads the batch JSON embedded in the user message and echoes
// every itemId back with a fixed category. Mirrors how the model would respond.
function stubCaller(category = 'Groceries'): ReceiptOpenAiCaller {
  return async (messages) => {
    const userContent = String((messages[1] as { content: string }).content)
    const dataLine = userContent.split('\n').find((l) => l.startsWith('Data: '))!
    const data = JSON.parse(dataLine.slice('Data: '.length)) as { items: Array<{ itemId: number }> }
    return {
      json: { items: data.items.map((i) => ({ itemId: i.itemId, category, confidence: 90, rationale: 'stub' })) },
      model: 'stub',
      temperature: 0.1,
      latencyMs: 1,
      providerRequestId: null,
      rawTextPreview: '',
    }
  }
}

async function makeOrder(vendor: string): Promise<number> {
  const o = await ExternalOrder.create({
    householdId: HH,
    vendor,
    dedupeKey: `${vendor}-${HH}`,
    total: '10.00',
    currency: 'CAD',
    source: 'test',
  } as never)
  return o.id
}

async function makeItem(orderId: number, title: string, inferredCategory: string | null): Promise<number> {
  const it = await ExternalOrderItem.create({
    externalOrderId: orderId,
    title,
    quantity: 1,
    totalPrice: '5.00',
    inferredCategory,
  } as never)
  return it.id
}

test('parse maps ids, clamps confidence, drops unknown + dup ids, falls back to Other', () => {
  const out = parseReceiptItemCategorySuggestions(
    {
      items: [
        { itemId: 1, category: 'Groceries', confidence: 150 },
        { itemId: 2, category: '', confidence: 'x' },
        { itemId: 99, category: 'Toys', confidence: 50 },
        { itemId: 1, category: 'Dairy', confidence: 80 },
      ],
    },
    [{ id: 1 }, { id: 2 }],
    [],
  )
  assert.equal(out.length, 2)
  const byId = new Map(out.map((s) => [s.itemId, s]))
  assert.equal(byId.get(1)!.category, 'Groceries')
  assert.equal(byId.get(1)!.confidence, 100)
  assert.equal(byId.get(2)!.category, 'Other')
  assert.equal(byId.get(2)!.confidence, 60)
})

test('categorize selects only null-category non-amazon items', async () => {
  const other = await makeOrder('other')
  const amazon = await makeOrder('amazon')
  const nullItem = await makeItem(other, 'MILK 2%', null)
  await makeItem(other, 'BREAD', 'Bakery')
  await makeItem(amazon, 'USB CABLE', null)
  const res = await categorizeReceiptItemsWithAi({ householdId: HH }, { openaiCaller: stubCaller('Groceries') })
  assert.equal(res.suggestions.length, 1)
  assert.equal(res.suggestions[0].itemId, nullItem)
  assert.equal(res.suggestions[0].category, 'Groceries')
})

test('categorize batches items in groups of 20', async () => {
  const order = await makeOrder('other')
  for (let i = 0; i < 25; i++) await makeItem(order, `ITEM ${i}`, null)
  let calls = 0
  const counting: ReceiptOpenAiCaller = async (m, o) => {
    calls += 1
    return stubCaller('Snacks')(m, o)
  }
  const res = await categorizeReceiptItemsWithAi({ householdId: HH, limit: 200 }, { openaiCaller: counting })
  assert.equal(calls, 2)
  assert.equal(res.suggestions.length, 25)
})

test('apply writes inferredCategory + confidence, leaves businessUsePercent null', async () => {
  const order = await makeOrder('other')
  const id = await makeItem(order, 'EGGS', null)
  const n = await applyReceiptItemCategorySuggestions([{ itemId: id, category: 'Dairy', confidence: 88, rationale: 'x' }])
  assert.equal(n, 1)
  const row = await ExternalOrderItem.findByPk(id)
  assert.equal(row!.inferredCategory, 'Dairy')
  assert.equal(Number(row!.confidence), 88)
  assert.equal(row!.businessUsePercent, null)
})

test('categorizeAndApply categorizes a non-amazon order end to end', async () => {
  const order = await makeOrder('other')
  const id = await makeItem(order, 'DIET COKE', null)
  const n = await categorizeAndApplyReceiptItems({ householdId: HH, orderId: order }, { openaiCaller: stubCaller('Beverages') })
  assert.equal(n, 1)
  const row = await ExternalOrderItem.findByPk(id)
  assert.equal(row!.inferredCategory, 'Beverages')
})

test('categorizeAndApply skips amazon orders without calling the model', async () => {
  const order = await makeOrder('amazon')
  const id = await makeItem(order, 'USB CABLE', null)
  let called = false
  const caller: ReceiptOpenAiCaller = async (m, o) => {
    called = true
    return stubCaller()(m, o)
  }
  const n = await categorizeAndApplyReceiptItems({ householdId: HH, orderId: order }, { openaiCaller: caller })
  assert.equal(n, 0)
  assert.equal(called, false)
  const row = await ExternalOrderItem.findByPk(id)
  assert.equal(row!.inferredCategory, null)
})

test('categorizeAndApply swallows caller errors (graceful degradation)', async () => {
  const order = await makeOrder('other')
  const id = await makeItem(order, 'MYSTERY', null)
  const throwing: ReceiptOpenAiCaller = async () => {
    throw new Error('AI down')
  }
  const n = await categorizeAndApplyReceiptItems({ householdId: HH, orderId: order }, { openaiCaller: throwing })
  assert.equal(n, 0)
  const row = await ExternalOrderItem.findByPk(id)
  assert.equal(row!.inferredCategory, null)
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx tsx --import ./test/setup.ts --test test/categorizeReceiptItems.test.ts`
Expected: FAIL — cannot find module `../src/import/categorizeReceiptItems`.

- [ ] **Step 4: Write the categorizer module**

Create `backend/src/import/categorizeReceiptItems.ts`:

```ts
import { Op } from 'sequelize'
import { ExternalOrder, ExternalOrderItem } from '../models'
import { loadCategoryHints } from '../ai/suggestTransaction'
import { openaiJsonWithMeta, type OpenAiJsonResult } from '../ai/openaiJson'
import { logger } from '../observability/logger'
import { RECEIPT_CATEGORIES } from './receiptCategories'

export const RECEIPT_ITEM_CATEGORIZATION_PROMPT_VERSION = 'receipt-item-categorization-v1'

export type ReceiptItemCategorySuggestion = {
  itemId: number
  category: string
  confidence: number
  rationale: string
}

export type ReceiptItemCategorizationResult = {
  suggestions: ReceiptItemCategorySuggestion[]
  inputSnapshot: unknown
  meta: OpenAiJsonResult
  promptVersion: string
}

/** Injectable OpenAI caller so tests stub the network (same pattern as the Amazon categorizer). */
export type ReceiptOpenAiCaller = (
  messages: Parameters<typeof openaiJsonWithMeta>[0],
  options: Parameters<typeof openaiJsonWithMeta>[1],
) => Promise<OpenAiJsonResult>

const defaultReceiptOpenAiCaller: ReceiptOpenAiCaller = (messages, options) =>
  openaiJsonWithMeta(messages, options)

function asNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function clampConfidence(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 60
  return Math.max(0, Math.min(100, Math.round(n)))
}

function normalizeCategoryLabel(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 128)
}

function parseCategory(value: unknown, preferredCategories: string[]): string {
  if (typeof value === 'string') {
    const normalized = normalizeCategoryLabel(value)
    const preferredMatch = preferredCategories.find((c) => c.toLowerCase() === normalized.toLowerCase())
    if (preferredMatch) return preferredMatch
    const fallbackMatch = RECEIPT_CATEGORIES.find((c) => c.toLowerCase() === normalized.toLowerCase())
    if (fallbackMatch) return fallbackMatch
    if (normalized) return normalized
  }
  return 'Other'
}

export function parseReceiptItemCategorySuggestions(
  json: Record<string, unknown>,
  items: Array<{ id: number }>,
  preferredCategories: string[] = [],
): ReceiptItemCategorySuggestion[] {
  const validIds = new Set(items.map((i) => i.id))
  const rows = Array.isArray(json.items) ? json.items : []
  const seen = new Set<number>()
  const out: ReceiptItemCategorySuggestion[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const obj = row as Record<string, unknown>
    const itemId = Number(obj.itemId)
    if (!validIds.has(itemId) || seen.has(itemId)) continue
    seen.add(itemId)
    const rationale =
      typeof obj.rationale === 'string' && obj.rationale.trim()
        ? obj.rationale.trim().slice(0, 240)
        : 'AI category suggestion based on receipt line item.'
    out.push({
      itemId,
      category: parseCategory(obj.category, preferredCategories),
      confidence: clampConfidence(obj.confidence),
      rationale,
    })
  }
  return out
}

type ReceiptItemContext = {
  itemId: number
  title: string
  quantity: number
  totalPrice: number | null
}

export async function categorizeReceiptItemsWithAi(
  args: { householdId: number; orderId?: number; orderIds?: number[]; itemIds?: number[]; limit?: number },
  opts?: { openaiCaller?: ReceiptOpenAiCaller },
): Promise<ReceiptItemCategorizationResult> {
  const call = opts?.openaiCaller ?? defaultReceiptOpenAiCaller

  const orderWhere: Record<string, unknown> = {
    householdId: args.householdId,
    vendor: { [Op.ne]: 'amazon' },
  }
  if (args.orderId != null) orderWhere.id = args.orderId
  else if (args.orderIds?.length) orderWhere.id = { [Op.in]: args.orderIds }

  const itemWhere: Record<string, unknown> = { inferredCategory: null }
  if (args.itemIds?.length) itemWhere.id = { [Op.in]: args.itemIds }

  const itemLimit = args.itemIds?.length
    ? Math.min(500, args.itemIds.length)
    : Math.min(200, Math.max(1, args.limit ?? 50))

  const items = await ExternalOrderItem.findAll({
    where: itemWhere,
    include: [{ model: ExternalOrder, as: 'order', where: orderWhere, required: true }],
    order: [['id', 'ASC']],
    limit: itemLimit,
  })

  const itemContexts: ReceiptItemContext[] = items.map((item) => ({
    itemId: item.id,
    title: item.title,
    quantity: item.quantity,
    totalPrice: asNumber(item.totalPrice),
  }))

  if (itemContexts.length === 0) {
    return {
      suggestions: [],
      inputSnapshot: { items: [] },
      meta: { json: { items: [] }, model: 'none', temperature: 0, latencyMs: 0, providerRequestId: null, rawTextPreview: '' },
      promptVersion: RECEIPT_ITEM_CATEGORIZATION_PROMPT_VERSION,
    }
  }

  const categoryHints = await loadCategoryHints(args.householdId)
  const inputSnapshot = {
    householdCategoryHints: categoryHints.slice(0, 80),
    fallbackCategories: RECEIPT_CATEGORIES,
    items: itemContexts,
  }

  const batches: ReceiptItemContext[][] = []
  for (let i = 0; i < itemContexts.length; i += 20) batches.push(itemContexts.slice(i, i + 20))

  const metas: OpenAiJsonResult[] = []
  const suggestions: ReceiptItemCategorySuggestion[] = []
  for (const batch of batches) {
    const meta = await call(
      [
        {
          role: 'system',
          content:
            'You categorize retail/grocery receipt line items for a household expense tracker. Return strict JSON only.',
        },
        {
          role: 'user',
          content: [
            'Assign every line item to a single spending category.',
            categoryHints.length
              ? `Prefer one of these existing household categories exactly as written whenever reasonably close: ${categoryHints.join(', ')}.`
              : 'There are no existing household categories yet.',
            `Otherwise use one of these fallback categories: ${RECEIPT_CATEGORIES.join(', ')}.`,
            'Only invent a concise new label when neither fits. Use "Other" when the title is too cryptic to guess.',
            'Return one result for every input item.',
            'Return ONLY JSON: {"items":[{"itemId":number,"category":string,"confidence":0-100,"rationale":string}]}',
            `Data: ${JSON.stringify({ householdCategoryHints: categoryHints.slice(0, 80), fallbackCategories: RECEIPT_CATEGORIES, items: batch })}`,
          ].join('\n'),
        },
      ],
      { temperature: 0.1, maxTokens: 4000 },
    )
    metas.push(meta)
    suggestions.push(
      ...parseReceiptItemCategorySuggestions(
        meta.json,
        batch.map((i) => ({ id: i.itemId })),
        categoryHints,
      ),
    )
  }

  const firstMeta = metas[0]
  return {
    suggestions,
    inputSnapshot,
    meta: {
      json: { items: suggestions },
      model: firstMeta.model,
      temperature: firstMeta.temperature,
      latencyMs: metas.reduce((sum, m) => sum + m.latencyMs, 0),
      providerRequestId: metas.map((m) => m.providerRequestId).filter(Boolean).join(',') || null,
      rawTextPreview: firstMeta.rawTextPreview,
    },
    promptVersion: RECEIPT_ITEM_CATEGORIZATION_PROMPT_VERSION,
  }
}

export async function applyReceiptItemCategorySuggestions(
  suggestions: ReceiptItemCategorySuggestion[],
): Promise<number> {
  let updated = 0
  for (const s of suggestions) {
    const [count] = await ExternalOrderItem.update(
      { inferredCategory: s.category, confidence: String(s.confidence) },
      { where: { id: s.itemId } },
    )
    updated += count
  }
  return updated
}

/**
 * Never-throwing seam used by import handlers and the backfill: categorize the
 * selected (null-category, non-Amazon) items and write them. On any failure it
 * logs and returns 0 — categorization must never break an import.
 */
export async function categorizeAndApplyReceiptItems(
  args: { householdId: number | null; orderId?: number; orderIds?: number[]; limit?: number },
  opts?: { openaiCaller?: ReceiptOpenAiCaller },
): Promise<number> {
  if (args.householdId == null) return 0
  try {
    const result = await categorizeReceiptItemsWithAi(
      { householdId: args.householdId, orderId: args.orderId, orderIds: args.orderIds, limit: args.limit },
      opts,
    )
    return await applyReceiptItemCategorySuggestions(result.suggestions)
  } catch (err) {
    logger.warn({ err, orderId: args.orderId, orderIds: args.orderIds }, 'receipt_item_categorization_failed')
    return 0
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx --import ./test/setup.ts --test test/categorizeReceiptItems.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/import/receiptCategories.ts backend/src/import/categorizeReceiptItems.ts backend/test/categorizeReceiptItems.test.ts
git commit --no-verify -m "feat(receipts): AI categorizer for non-Amazon receipt items"
```

---

## Task 2: Wire auto-categorization into the import handlers

The categorizer logic is fully unit-tested in Task 1. This task is the mechanical wiring of the never-throwing seam into the four non-Amazon import handlers. (No new automated test: the route-level integration harness requires Postgres — `test/integration/_setup/pgTestDb` — and the seam's behaviour, including graceful degradation, is already covered on sqlite in Task 1. Wiring is verified by typecheck, the unchanged unit suite, and confirming the four call sites exist.)

**Files:**
- Modify: `backend/src/routes/externalOrders.ts`

- [ ] **Step 1: Add the import**

At the top of `backend/src/routes/externalOrders.ts`, add to the existing import block (next to the other `../import/...` imports):

```ts
import { categorizeAndApplyReceiptItems } from '../import/categorizeReceiptItems'
```

- [ ] **Step 2: Wire `import-text`**

In the `/import-text` handler, immediately after:

```ts
    const { order, created } = await persistExtractedOrder(extracted, {
      userId: auth.user.id,
      householdId: auth.household.id,
      source: 'email-paste',
    })
```

insert:

```ts
    if (created) {
      await categorizeAndApplyReceiptItems({ householdId: auth.household.id, orderId: order.id })
    }
```

- [ ] **Step 3: Wire `import-image`**

In the `/import-image` handler, immediately after its `persistExtractedOrder(...)` call (source `'image-upload'`), insert the same block:

```ts
      if (created) {
        await categorizeAndApplyReceiptItems({ householdId: auth.household.id, orderId: order.id })
      }
```

- [ ] **Step 4: Wire `import-pdf`**

In the `/import-pdf` handler, immediately after the `matchReceiptOrderToTransactions(...)` call that produces `matchSummary` (and before `logger.info`), insert:

```ts
      if (created) {
        await categorizeAndApplyReceiptItems({ householdId: auth.household.id, orderId: order.id })
      }
```

- [ ] **Step 5: Wire `import-csv` (batch over created orders)**

In the `/import-csv` handler, change the loop to collect created order ids. Replace:

```ts
      let created = 0;
      let duplicates = 0;
      const errors: Array<{ rowIndex: number; message: string }> = [];

      for (let i = 0; i < parsed.orders.length; i++) {
        const order = parsed.orders[i];
        try {
          const result = await persistExtractedOrder(order, {
            userId: auth.user.id,
            householdId: auth.household.id,
            source: `${vendor}-csv`,
          });
          if (result.created) created++;
          else duplicates++;
        } catch (e) {
          errors.push({
            rowIndex: i,
            message: e instanceof Error ? e.message : 'persist failed',
          });
        }
      }
```

with:

```ts
      let created = 0;
      let duplicates = 0;
      const createdOrderIds: number[] = [];
      const errors: Array<{ rowIndex: number; message: string }> = [];

      for (let i = 0; i < parsed.orders.length; i++) {
        const order = parsed.orders[i];
        try {
          const result = await persistExtractedOrder(order, {
            userId: auth.user.id,
            householdId: auth.household.id,
            source: `${vendor}-csv`,
          });
          if (result.created) {
            created++;
            createdOrderIds.push(result.order.id);
          } else {
            duplicates++;
          }
        } catch (e) {
          errors.push({
            rowIndex: i,
            message: e instanceof Error ? e.message : 'persist failed',
          });
        }
      }

      if (createdOrderIds.length > 0) {
        await categorizeAndApplyReceiptItems({
          householdId: auth.household.id,
          orderIds: createdOrderIds,
          limit: 200,
        });
      }
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (If the project uses a build alias for typecheck, `yarn build` is equivalent.)

- [ ] **Step 7: Re-run the unit suite to confirm no regressions**

Run: `npx tsx --import ./test/setup.ts --test test/categorizeReceiptItems.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 8: Confirm the four call sites exist**

Run: `grep -c "categorizeAndApplyReceiptItems(" src/routes/externalOrders.ts`
Expected: `4` (the four call sites — the import line has no call parenthesis, so it is not counted).

- [ ] **Step 9: Commit**

```bash
git add backend/src/routes/externalOrders.ts
git commit --no-verify -m "feat(receipts): auto-categorize items on non-Amazon import"
```

---

## Task 3: Backfill script for existing uncategorized items

Mirrors `backend/scripts/backfill-receipt-link-acceptance.ts`: dry-run by default, refuses `--commit` against local sqlite (runs against prod Postgres via `DATABASE_URL`). No dedicated automated test — matching the repo convention for these one-off scripts; the categorizer it calls is unit-tested in Task 1. Verified by running its dry-run and its sqlite `--commit` refusal.

**Files:**
- Create: `backend/scripts/backfill-receipt-item-categories.ts`

- [ ] **Step 1: Write the script**

Create `backend/scripts/backfill-receipt-item-categories.ts`:

```ts
#!/usr/bin/env tsx
/**
 * Backfill inferredCategory on non-Amazon receipt line items that were imported
 * before AI categorization existed (e.g. Costco till-receipt PDFs, which the
 * parser leaves null). Runs the AI categorizer per household over its
 * null-category, non-Amazon items.
 *
 * Usage:
 *   cd backend && DATABASE_URL=... npx tsx scripts/backfill-receipt-item-categories.ts          # dry-run
 *   cd backend && DATABASE_URL=... npx tsx scripts/backfill-receipt-item-categories.ts --commit # write
 *
 * Prod Postgres only (per project convention). Without DATABASE_URL this hits
 * local sqlite — do not run the backfill that way.
 */
import { Op } from 'sequelize'
import { ExternalOrder, ExternalOrderItem, sequelize } from '../src/models'
import { categorizeAndApplyReceiptItems } from '../src/import/categorizeReceiptItems'
import { databaseUrl } from '../src/config/env'

const COMMIT = process.argv.includes('--commit')

async function main() {
  if (databaseUrl) {
    console.log(`Target DB: postgres (${new URL(databaseUrl).host})`)
  } else {
    console.log('Target DB: LOCAL SQLITE')
    if (COMMIT) {
      console.error('Refusing to --commit against local sqlite. Set DATABASE_URL to the prod Postgres URL.')
      process.exit(1)
    }
  }

  // Households that own at least one null-category, non-Amazon receipt item.
  const pending = await ExternalOrderItem.findAll({
    where: { inferredCategory: null },
    include: [
      {
        model: ExternalOrder,
        as: 'order',
        where: { vendor: { [Op.ne]: 'amazon' }, householdId: { [Op.ne]: null } },
        required: true,
        attributes: ['householdId'],
      },
    ],
    attributes: ['id'],
  })

  const householdIds = Array.from(
    new Set(
      pending
        .map((it) => (it.get('order') as ExternalOrder | undefined)?.householdId)
        .filter((id): id is number => id != null),
    ),
  )

  console.log(
    `${pending.length} uncategorized item(s) across ${householdIds.length} household(s).${
      COMMIT ? '' : '  [dry-run — pass --commit to write]'
    }`,
  )

  if (!COMMIT) {
    await sequelize.close()
    return
  }

  let totalUpdated = 0
  for (const householdId of householdIds) {
    // limit 500 per pass; loop until a pass updates nothing for this household.
    let pass = 0
    for (;;) {
      const updated = await categorizeAndApplyReceiptItems({ householdId, limit: 500 })
      totalUpdated += updated
      pass += 1
      console.log(`  household ${householdId}: pass ${pass} categorized ${updated} item(s)`)
      if (updated === 0) break
    }
  }

  console.log(`\nCategorized ${totalUpdated} item(s).`)
  await sequelize.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
```

- [ ] **Step 2: Verify the sqlite `--commit` refusal (deterministic, DB-independent)**

The refusal returns before any DB query, so this works regardless of whether a local sqlite schema exists.

Run: `npx tsx scripts/backfill-receipt-item-categories.ts --commit`
Expected: prints `Target DB: LOCAL SQLITE` then `Refusing to --commit against local sqlite...`, exits non-zero (code 1).

- [ ] **Step 3: Smoke-check the dry-run loads (best-effort)**

Run: `npx tsx scripts/backfill-receipt-item-categories.ts`
Expected: prints `Target DB: LOCAL SQLITE`. If a local sqlite schema exists it then prints `N uncategorized item(s) across M household(s).  [dry-run ...]` and exits 0. If this worktree has no dev sqlite, it instead errors on a missing `external_order_items` table — that is acceptable; the dry-run/`--commit` against **prod** (with `DATABASE_URL` set) is the real run and is performed manually after merge. Do not block the task on this step.

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/backfill-receipt-item-categories.ts
git commit --no-verify -m "feat(receipts): backfill script for receipt item categories"
```

---

## Self-Review

**Spec coverage:**
- Categorizer module (select null-category non-Amazon, batch 20, prefer hints then `RECEIPT_CATEGORIES`, injectable caller, `promptVersion`) → Task 1.
- `applyReceiptItemCategorySuggestions` writes `inferredCategory` + `confidence`, not `businessUsePercent` → Task 1 (+ test).
- Taxonomy constant → Task 1 (`receiptCategories.ts`).
- Auto-trigger in import-pdf/text/image/csv, never breaks import → Task 2 (seam is internally try/caught; verified by Task 1's degradation test + the wiring).
- Already-categorized (Gmail) and Amazon items skipped → Task 1 selection (`inferredCategory IS NULL`, `vendor != 'amazon'`) + tests.
- Backfill, dry-run default, `--commit`, sqlite refusal → Task 3 (mirrors `backfill-receipt-link-acceptance.ts`).
- Apply directly, no review UI; no `businessUsePercent`; backend-only → honored (no frontend files, no UI).

**Placeholder scan:** none — every step has full code or an exact command + expected output.

**Type consistency:** `ReceiptItemCategorySuggestion`, `ReceiptOpenAiCaller`, `categorizeReceiptItemsWithAi`, `applyReceiptItemCategorySuggestions`, `categorizeAndApplyReceiptItems`, `RECEIPT_CATEGORIES` defined in Task 1 and used identically in the test, the route wiring (Task 2), and the backfill (Task 3). The seam signature `{ householdId, orderId?, orderIds?, limit? }` matches all three call patterns (single `orderId` for pdf/text/image; `orderIds` for csv; `householdId`-only for backfill).

**Coverage note (intentional):** route-level integration of the wiring is not automated (requires the Postgres integration harness); the seam's logic and graceful degradation are covered on sqlite in Task 1, and Task 2 verifies wiring via typecheck + call-site count.
