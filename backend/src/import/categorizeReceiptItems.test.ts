import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { sequelize, ExternalOrder, ExternalOrderItem } from '../models'
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
