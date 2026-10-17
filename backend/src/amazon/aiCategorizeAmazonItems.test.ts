/**
 * Colocated coverage for `applyAmazonItemCategorySuggestions`.
 *
 * Why this file exists: this writer's category-FK fix had NO unit test. The only
 * test touching it was `test/integration/importOrchestratorEdgeCases.test.ts`,
 * which asserts the string column alone, never the id, never a path form, and
 * never the null-household fallback — and being an integration test it is
 * Postgres-only, so it does not run in the unit job at all. Reverting the fix
 * left every unit test green.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, Category, ExternalOrder, ExternalOrderItem, Household } from '../models';
import { assertApplyWriterResolvesCategories } from '../../test/helpers/categoryMirrorApplyCases';
import {
  applyAmazonItemCategorySuggestions,
  type AmazonItemCategorySuggestion,
} from './aiCategorizeAmazonItems';

before(async () => {
  await sequelize.sync({ force: true });
});

// A fresh household per test: the DB is force-synced once and then accumulates,
// so rows from other tests must never bleed into these queries. The household
// row itself has to exist because categories.household_id carries an FK to it.
let HH = 0;
let orderId = 0;
beforeEach(async () => {
  HH += 1;
  await Household.create({ name: `H${HH}` } as never);
  const order = await ExternalOrder.create({
    householdId: HH,
    vendor: 'amazon',
    dedupeKey: `amazon-${HH}`,
    total: '10.00',
    currency: 'CAD',
    source: 'test',
  } as never);
  orderId = order.id;
});

async function makeItem(title: string): Promise<number> {
  const item = await ExternalOrderItem.create({
    externalOrderId: orderId,
    title,
    quantity: 1,
    totalPrice: '5.00',
    inferredCategory: null,
  } as never);
  return item.id;
}

function suggestion(over: Partial<AmazonItemCategorySuggestion>): AmazonItemCategorySuggestion {
  return {
    itemId: 0,
    category: 'Office Equipment',
    businessUsePercent: null,
    confidence: 88,
    rationale: 'stub',
    usedExistingCategory: false,
    ...over,
  };
}

test('applyAmazonItemCategorySuggestions resolves the category id and a FLAT name in every case', async () => {
  await assertApplyWriterResolvesCategories({
    householdId: HH,
    makeItem,
    apply: (itemId, category, householdId) =>
      applyAmazonItemCategorySuggestions([suggestion({ itemId, category })], householdId),
  });
});

test('applyAmazonItemCategorySuggestions still writes confidence and businessUsePercent', async () => {
  // The category fix must not have disturbed the writer's other two columns.
  const itemId = await makeItem('USB CABLE');
  const updated = await applyAmazonItemCategorySuggestions(
    [suggestion({ itemId, category: 'Electronics', businessUsePercent: 40, confidence: 73 })],
    HH,
  );
  assert.equal(updated, 1);
  const row = (await ExternalOrderItem.findByPk(itemId))!;
  assert.equal(row.inferredCategory, 'Electronics');
  assert.equal(Number(row.confidence), 73);
  assert.equal(Number(row.businessUsePercent), 40);
  const created = await Category.findOne({ where: { householdId: HH, name: 'Electronics' } });
  assert.equal(row.inferredCategoryId, created!.id);
});

test('applyAmazonItemCategorySuggestions counts only rows it actually updated', async () => {
  const itemId = await makeItem('SD CARD');
  const updated = await applyAmazonItemCategorySuggestions(
    [suggestion({ itemId, category: 'Storage' }), suggestion({ itemId: itemId + 10_000, category: 'Storage' })],
    HH,
  );
  assert.equal(updated, 1, 'a suggestion for a missing item contributes nothing');
});
