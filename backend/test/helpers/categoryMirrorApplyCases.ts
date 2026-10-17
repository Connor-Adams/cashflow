/**
 * Shared assertion matrix for the two "apply AI suggestions" static writers of
 * `external_order_items.inferred_category`:
 *
 * - `applyReceiptItemCategorySuggestions` (`src/import/categorizeReceiptItems.ts`)
 * - `applyAmazonItemCategorySuggestions`  (`src/amazon/aiCategorizeAmazonItems.ts`)
 *
 * Both take a suggestion list plus a nullable `householdId`, both write with a
 * static `ExternalOrderItem.update` — which bypasses the model's `beforeSave`
 * hook, the only thing that otherwise reconciles the string mirror into
 * `inferred_category_id` — and both must therefore resolve the category
 * themselves through `resolveCategoryMirror`. One matrix keeps them from
 * drifting and keeps two byte-identical assertion blocks out of the tree (the
 * sibling `inferredCategoryFixture.ts` does the same for the three INGEST
 * writers, whose input shape is an item list rather than a suggestion list).
 */
import assert from 'node:assert/strict';

/** Run the writer under test over ONE suggestion; returns its updated count. */
export type ApplyCategoryWriter = (
  itemId: number,
  category: string,
  householdId: number | null,
) => Promise<number>;

/**
 * Drive one writer through every category-resolution behaviour: a flat known
 * name, the same leaf in path form, a MALFORMED path, an unknown name, and no
 * household. The caller owns the household row and supplies a way to mint one
 * fresh item per case.
 */
export async function assertApplyWriterResolvesCategories(args: {
  householdId: number;
  /** Create one item to categorize and return its id. */
  makeItem: (title: string) => Promise<number>;
  apply: ApplyCategoryWriter;
}): Promise<void> {
  const { Category, ExternalOrderItem } = await import('../../src/models');
  const { householdId, makeItem, apply } = args;

  const houseRoot = await Category.create({ householdId, name: 'Household', parentId: null } as never);
  const rent = await Category.create({ householdId, name: 'Rent', parentId: houseRoot.id } as never);
  const categoryCount = (): Promise<number> => Category.count({ where: { householdId } });

  /** Apply one suggestion and hand back the row it wrote. */
  async function applyOne(
    title: string,
    category: string,
    hh: number | null,
  ): Promise<ExternalOrderItem> {
    const itemId = await makeItem(title);
    assert.equal(await apply(itemId, category, hh), 1, `${category}: one row must be updated`);
    return (await ExternalOrderItem.findByPk(itemId))!;
  }

  // (a) A flat KNOWN name resolves to the existing nested leaf; the FK is written.
  const flat = await applyOne('JUNE RENT', 'Rent', householdId);
  assert.equal(flat.inferredCategory, 'Rent');
  assert.equal(flat.inferredCategoryId, rent.id, 'the FK must be written, not left NULL');

  // (b) A PATH form (what loadCategoryHints feeds the model, and what it echoes
  // back) resolves to that same leaf and never reaches the string column — every
  // budget and spend rollup joins that column as an exact string.
  const path = await applyOne('JULY RENT', 'Household / Rent', householdId);
  assert.equal(path.inferredCategory, 'Rent', 'a path form must never reach inferred_category');
  assert.equal(path.inferredCategoryId, rent.id);

  // (c) A MALFORMED path cannot be parsed, so the first resolution returns null.
  // The FK must still NOT be null: a flat name beside a NULL id is exactly the
  // row state this change exists to stop producing, so the leaf segment is
  // re-resolved on its own.
  const malformed = await applyOne('AUG RENT', 'Household // Rent', householdId);
  assert.equal(malformed.inferredCategory, 'Rent');
  assert.equal(
    malformed.inferredCategoryId,
    rent.id,
    'a household was present, so the FK must be resolved, not left NULL',
  );

  assert.equal(await categoryCount(), 2, 'none of the resolvable cases created a category');

  // (d) An UNKNOWN name is created and linked.
  const unknown = await applyOne('MYSTERY JAR', 'Sundries', householdId);
  assert.equal(unknown.inferredCategory, 'Sundries');
  const sundries = await Category.findOne({ where: { householdId, name: 'Sundries' } });
  assert.ok(sundries, 'an unknown name must be created');
  assert.equal(unknown.inferredCategoryId, sundries!.id);

  // (e) With NO household there is nothing to resolve against, so the FK stays
  // null — but a path form must still degrade to its last segment.
  const noHousehold = await applyOne('ORPHAN RENT', 'Household / Rent', null);
  assert.equal(noHousehold.inferredCategory, 'Rent', 'the path form must never reach inferred_category');
  assert.equal(noHousehold.inferredCategoryId, null);
  assert.equal(await categoryCount(), 3, 'the null-household write created nothing');
}
