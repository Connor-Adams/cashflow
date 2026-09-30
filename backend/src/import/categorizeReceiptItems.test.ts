import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { sequelize, Category, ExternalOrder, ExternalOrderItem, Household } from '../models'
import {
  parseReceiptItemCategorySuggestions,
  categorizeReceiptItemsWithAi,
  applyReceiptItemCategorySuggestions,
  categorizeAndApplyReceiptItems,
  type ReceiptOpenAiCaller,
} from './categorizeReceiptItems'

before(async () => {
  await sequelize.sync({ force: true })
})

// Each test gets a unique householdId so rows from other tests (the DB is
// force-synced once, then accumulates) never bleed into its queries.
let HH = 0
beforeEach(async () => {
  HH += 1
  // The ExternalOrderItem beforeSave hook calls resolveCategoryIdByName which
  // does Category.findOrCreate — categories.household_id has a FK to households.
  // Create a matching Household row so the FK is satisfied.
  await Household.create({ name: `H${HH}` } as never)
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

test('categorize selects non-amazon items missing a confidence, regardless of prior category', async () => {
  const other = await makeOrder('other')
  const amazon = await makeOrder('amazon')
  const nullCat = await makeItem(other, 'MILK 2%', null) // no category, no confidence → selected
  const hasCat = await makeItem(other, 'BREAD', 'Bakery') // deterministic category but no confidence → now selected
  await makeItem(amazon, 'USB CABLE', null) // amazon vendor → excluded
  // Already-confident item → excluded (no rework).
  await ExternalOrderItem.create({
    externalOrderId: other,
    title: 'DONE',
    quantity: 1,
    totalPrice: '5.00',
    inferredCategory: 'Snacks',
    confidence: '88',
  } as never)
  const res = await categorizeReceiptItemsWithAi({ householdId: HH }, { openaiCaller: stubCaller('Groceries') })
  const ids = res.suggestions.map((s) => s.itemId).sort((a, b) => a - b)
  assert.deepEqual(ids, [nullCat, hasCat].sort((a, b) => a - b))
  assert.equal(res.suggestions.every((s) => s.category === 'Groceries'), true)
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
  const n = await applyReceiptItemCategorySuggestions(
    [{ itemId: id, category: 'Dairy', confidence: 88, rationale: 'x' }],
    HH,
  )
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

// ---------------------------------------------------------------------------
// category id + flat name persistence.
//
// `ExternalOrderItem.update` is a STATIC update, so it bypasses the
// `beforeSave` hook that reconciles `inferred_category` into
// `inferred_category_id`. The writer therefore has to resolve the category
// itself, and it has to write the resolved leaf's FLAT name:
// `loadCategoryHints` feeds the model path-form hints ("Household / Rent")
// which it echoes back, and every budget and spend rollup joins the category
// mirror as an exact string — so a path form in that column joins nothing.
// Same coverage as the other three AI writers fixed alongside this one.
// ---------------------------------------------------------------------------

// Arrange-and-apply for the category-mirror tests below: one item, one
// suggestion, and the row read back after the write.
async function applyOne(
  title: string,
  category: string,
  householdId: number | null,
): Promise<{ count: number; row: ExternalOrderItem }> {
  const order = await makeOrder('other')
  const id = await makeItem(order, title, null)
  const count = await applyReceiptItemCategorySuggestions(
    [{ itemId: id, category, confidence: 88, rationale: 'x' }],
    householdId,
  )
  return { count, row: (await ExternalOrderItem.findByPk(id))! }
}

test('apply resolves a path-form name to the leaf id and a flat name, never a path', async () => {
  const houseRoot = await Category.create({ householdId: HH, name: 'Household', parentId: null } as never)
  const rent = await Category.create({ householdId: HH, name: 'Rent', parentId: houseRoot.id } as never)

  // The model echoes back a hint from loadCategoryHints, which is path-form.
  const { count, row } = await applyOne('RENT', 'Household / Rent', HH)
  assert.equal(count, 1)
  assert.equal(row.inferredCategory, 'Rent', 'the path form must never reach inferred_category')
  assert.equal(row.inferredCategoryId, rent.id)
  assert.equal(await Category.count({ where: { householdId: HH } }), 2, 'no new category is created')
})

test('apply resolves a flat known name to that existing category id', async () => {
  const dairy = await Category.create({ householdId: HH, name: 'Dairy', parentId: null } as never)

  const { count, row } = await applyOne('EGGS', 'Dairy', HH)
  assert.equal(count, 1)
  assert.equal(row.inferredCategory, 'Dairy')
  assert.equal(row.inferredCategoryId, dairy.id)
  assert.equal(await Category.count({ where: { householdId: HH } }), 1, 'no new category is created')
})

test('apply creates an unknown flat name and stores its new id', async () => {
  const { count, row } = await applyOne('MYSTERY JAR', 'Sundries', HH)
  assert.equal(count, 1)
  assert.equal(row.inferredCategory, 'Sundries')
  const created = await Category.findOne({ where: { householdId: HH, name: 'Sundries' } })
  assert.notEqual(created, null)
  assert.equal(row.inferredCategoryId, created!.id)
})

test('apply with no household falls back to the leaf segment and a null id', async () => {
  const { count, row } = await applyOne('RENT', 'Household / Rent', null)
  assert.equal(count, 1)
  assert.equal(row.inferredCategory, 'Rent', 'the path form must never reach inferred_category')
  assert.equal(row.inferredCategoryId, null)
  assert.equal(await Category.count({ where: { householdId: HH } }), 0, 'nothing is created')
})

test('categorizeAndApply threads the household so the id lands too', async () => {
  const order = await makeOrder('other')
  const id = await makeItem(order, 'DIET COKE', null)
  const bev = await Category.create({ householdId: HH, name: 'Beverages', parentId: null } as never)

  const n = await categorizeAndApplyReceiptItems(
    { householdId: HH, orderId: order },
    { openaiCaller: stubCaller('Beverages') },
  )
  assert.equal(n, 1)
  const row = await ExternalOrderItem.findByPk(id)
  assert.equal(row!.inferredCategory, 'Beverages')
  assert.equal(row!.inferredCategoryId, bev.id)
})
