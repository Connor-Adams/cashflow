/**
 * Shared fixture + assertion matrix for the category-FK tests that cover the
 * three receipt-INGEST writers of `external_order_items.inferred_category`:
 *
 * - `persistExtractedOrder`        (`src/routes/externalOrders.ts`)
 * - `scanInbox`                    (`src/integrations/scanReceipts.ts`)
 * - `persistHighConfidenceOrder`   (`src/integrations/discoverReceiptSources.ts`)
 *
 * All three write with a static `ExternalOrderItem.bulkCreate` and no
 * `individualHooks`, so the model's `beforeSave` hook — the only thing that
 * reconciles the string mirror into `inferred_category_id` — never runs for
 * them; they go through `buildExternalOrderItemRows` instead, and must behave
 * identically. One fixture and one assertion matrix keeps them honest about
 * that, and keeps three byte-identical assertion blocks out of the tree (they
 * were a jscpd clone group).
 *
 * The caller seeds a nested `Household / Rent` pair and passes the leaf id.
 */
import assert from 'node:assert/strict';
import type { ExtractedReceiptItem } from '../../src/ai/extractReceiptItems';

/**
 * One item per behaviour under test: a flat KNOWN name, the same leaf in PATH
 * form, an UNKNOWN name, no name at all, and a MALFORMED path (empty segment) —
 * the one case a household-present write cannot resolve in a single step, and
 * which must therefore fall back to re-resolving the leaf segment rather than to
 * a NULL foreign key.
 */
export function inferredCategoryFixtureItems(): ExtractedReceiptItem[] {
  return [
    { title: 'June rent', quantity: 1, unitPrice: 20, totalPrice: 20, inferredCategory: 'Rent' },
    { title: 'July rent', quantity: 1, unitPrice: 20, totalPrice: 20, inferredCategory: 'Household / Rent' },
    { title: 'Odd bits', quantity: 1, unitPrice: 1, totalPrice: 1, inferredCategory: 'Sundries' },
    { title: 'No guess', quantity: 1, unitPrice: 1, totalPrice: 1, inferredCategory: null },
    { title: 'Malformed', quantity: 1, unitPrice: 1, totalPrice: 1, inferredCategory: 'Household // Rent' },
  ];
}

/** Assert what {@link inferredCategoryFixtureItems} must have persisted. */
export async function assertInferredCategoriesResolved(args: {
  externalOrderId: number;
  householdId: number;
  /** Id of the seeded `Rent` leaf nested under a `Household` root. */
  rentId: number;
}): Promise<void> {
  const { Category, ExternalOrderItem } = await import('../../src/models');
  const items = await ExternalOrderItem.findAll({
    where: { externalOrderId: args.externalOrderId },
    order: [['id', 'ASC']],
  });
  assert.equal(items.length, 5);

  // (a) A flat KNOWN name resolves to the existing nested leaf, FK written.
  assert.equal(items[0].inferredCategory, 'Rent');
  assert.equal(items[0].inferredCategoryId, args.rentId, 'the FK must be written, not left NULL');

  // A path form resolves to that same leaf and never lands in the string column.
  assert.equal(items[1].inferredCategory, 'Rent', 'a path form must never reach inferred_category');
  assert.equal(items[1].inferredCategoryId, args.rentId);

  // (b) An UNKNOWN name is created and linked, the way ensureCategory always has.
  const sundries = await Category.findOne({
    where: { householdId: args.householdId, nameKey: 'sundries' },
  });
  assert.ok(sundries, 'an unknown name must be created');
  assert.equal(items[2].inferredCategory, 'Sundries');
  assert.equal(items[2].inferredCategoryId, sundries!.id);

  // No name at all stays null on BOTH columns.
  assert.equal(items[3].inferredCategory, null);
  assert.equal(items[3].inferredCategoryId, null);

  // (c) A MALFORMED path (empty segment) cannot be parsed, so the first
  // resolution returns null — but the FK must NOT be left null: writing a flat
  // name beside a NULL id is exactly the state this whole change exists to stop
  // producing. `resolveCategoryMirror` re-resolves the LAST PATH SEGMENT on its
  // own, so this lands on the same Rent leaf as the well-formed path above.
  assert.equal(items[4].inferredCategory, 'Rent', 'never the raw string, which is the path form');
  assert.equal(
    items[4].inferredCategoryId,
    args.rentId,
    'a household was present, so the FK must be resolved, not left NULL',
  );

  // Every row keeps confidence null. These writers set it to null unconditionally
  // — which also PINS that the AI item categorizer (`categorizeAndApplyReceiptItems`,
  // called right after ingest by scanInbox and persistHighConfidenceOrder) did not
  // run: its selector is `{ confidence: null }`, so had it run it would have
  // rewritten every row here, not just the null-category one. It stays inert in
  // tests only because `backend/test/setup.ts` deletes OPENAI_API_KEY.
  for (const [index, item] of items.entries()) {
    assert.equal(item.confidence, null, `item ${index} must not have been re-categorized`);
  }
}

/**
 * The single-item, no-household case: there is nothing to resolve against, so
 * the FK stays null — but a PATH-FORM value must still degrade to its last
 * segment rather than being written back raw, which is the whole bug. Shared by
 * the two ingest writers whose `householdId` is nullable (`persistExtractedOrder`
 * and `scanInbox`); `persistHighConfidenceOrder` types it as required.
 */
export async function assertNoHouseholdFallback(externalOrderId: number): Promise<void> {
  const { ExternalOrderItem } = await import('../../src/models');
  const items = await ExternalOrderItem.findAll({ where: { externalOrderId } });
  assert.equal(items.length, 1);
  assert.equal(items[0].inferredCategory, 'Rent', 'the path form must never land in inferred_category');
  assert.equal(items[0].inferredCategoryId, null);
}
