import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Category: typeof import('../models/Category').Category;
let Household: typeof import('../models/Household').Household;
let ensureCategory: typeof import('./ensureCategory').ensureCategory;
let resolveCategoryMirror: typeof import('./ensureCategory').resolveCategoryMirror;

before(async () => {
  const models = await import('../models');
  sequelize = models.sequelize;
  Category = models.Category;
  Household = models.Household;
  const util = await import('./ensureCategory');
  ensureCategory = util.ensureCategory;
  resolveCategoryMirror = util.resolveCategoryMirror;
  await sequelize.sync({ force: true });
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await Category.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
});

test('ensureCategory: inserts new (household, name) row', async () => {
  const hh = await Household.create({ name: 'H' });
  await ensureCategory(hh.id, 'Groceries');
  const rows = await Category.findAll({ where: { householdId: hh.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Groceries');
  assert.equal(rows[0].icon, null);
});

test('ensureCategory: trims and deduplicates', async () => {
  const hh = await Household.create({ name: 'H' });
  await ensureCategory(hh.id, '  Rent ');
  await ensureCategory(hh.id, 'Rent');
  const rows = await Category.findAll({ where: { householdId: hh.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Rent');
});

test('ensureCategory: ignores null/empty/whitespace', async () => {
  const hh = await Household.create({ name: 'H' });
  await ensureCategory(hh.id, null);
  await ensureCategory(hh.id, '');
  await ensureCategory(hh.id, '   ');
  const rows = await Category.findAll({ where: { householdId: hh.id } });
  assert.equal(rows.length, 0);
});

test('ensureCategory: a "Parent / Child" name resolves to nested rows, not a flat root', async () => {
  const hh = await Household.create({ name: 'H' });
  await ensureCategory(hh.id, 'Household / Vape');
  const rows = await Category.findAll({ where: { householdId: hh.id }, order: [['id', 'ASC']] });
  // exactly two rows: a "Household" root and a "Vape" child under it — never a flat
  // top-level "Household / Vape" row.
  assert.equal(rows.length, 2);
  const root = rows.find((r) => r.parentId == null);
  const child = rows.find((r) => r.parentId != null);
  assert.equal(root?.name, 'Household');
  assert.equal(child?.name, 'Vape');
  assert.equal(child?.parentId, root?.id);
  assert.equal(rows.some((r) => r.name.includes('/')), false);
});

test('ensureCategory: a path reuses existing nested categories instead of duplicating', async () => {
  const hh = await Household.create({ name: 'H' });
  const household = await Category.create({ householdId: hh.id, name: 'Household', parentId: null, icon: null });
  await Category.create({ householdId: hh.id, name: 'Vape', parentId: household.id, icon: null });
  await ensureCategory(hh.id, 'Household / Vape');
  const rows = await Category.findAll({ where: { householdId: hh.id } });
  assert.equal(rows.length, 2); // no new rows created
});

test('ensureCategory: swallows an invalid path (empty segment) without throwing or writing', async () => {
  const hh = await Household.create({ name: 'H' });
  await ensureCategory(hh.id, 'Foo / / Bar'); // empty middle segment
  const rows = await Category.findAll({ where: { householdId: hh.id } });
  assert.equal(rows.length, 0);
});

test('ensureCategory: a repeated-segment path truncates instead of being rejected', async () => {
  // resolveCategoryPath truncates at the repeated name rather than throwing, so a
  // mirror name like "Food / Bar / Food" resolves to Bar under Food and writes
  // exactly those two reachable rows — no dangling node, and no swallowed error.
  const hh = await Household.create({ name: 'H' });
  await ensureCategory(hh.id, 'Food / Bar / Food');
  const rows = await Category.findAll({ where: { householdId: hh.id }, order: [['id', 'ASC']] });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Food');
  assert.equal(rows[0].parentId, null);
  assert.equal(rows[1].name, 'Bar');
  assert.equal(rows[1].parentId, rows[0].id);
});

test('ensureCategory: preserves existing icon on re-upsert', async () => {
  const hh = await Household.create({ name: 'H' });
  await ensureCategory(hh.id, 'Coffee');
  const row = await Category.findOne({ where: { householdId: hh.id, name: 'Coffee' } });
  if (!row) throw new Error('row missing');
  row.set('icon', 'Coffee');
  await row.save();
  await ensureCategory(hh.id, 'Coffee');
  const after = await Category.findOne({ where: { householdId: hh.id, name: 'Coffee' } });
  assert.equal(after?.icon, 'Coffee');
});

test('ensureCategory: returns the leaf id and its FLAT name for a path', async () => {
  const hh = await Household.create({ name: 'H' });
  const leaf = await ensureCategory(hh.id, 'Household / Rent');
  assert.ok(leaf);
  assert.equal(leaf!.name, 'Rent', 'the caller writes this into final_category, so it must be flat');
  assert.equal((await Category.findByPk(leaf!.id))?.name, 'Rent');
});

test('ensureCategory: returns the existing node for a flat name already nested elsewhere', async () => {
  const hh = await Household.create({ name: 'H' });
  const subs = await Category.create({ householdId: hh.id, name: 'Subscriptions', parentId: null, icon: null });
  const ai = await Category.create({ householdId: hh.id, name: 'Ai', parentId: subs.id, icon: null });
  const leaf = await ensureCategory(hh.id, 'Ai');
  assert.equal(leaf?.id, ai.id);
  assert.equal(leaf?.name, 'Ai');
});

test('ensureCategory: returns null for an empty name and for a malformed path', async () => {
  const hh = await Household.create({ name: 'H' });
  assert.equal(await ensureCategory(hh.id, null), null);
  assert.equal(await ensureCategory(hh.id, '   '), null);
  assert.equal(await ensureCategory(hh.id, 'Work//Internet'), null);
});

// ---------------------------------------------------------------------------
// resolveCategoryMirror — the two-step resolution all seven static category
// writers share. Step 2 is the point: a MALFORMED path makes step 1 return
// null, and persisting the leaf segment with a NULL FK would recreate exactly
// the flat-name-plus-NULL-id row these writers exist to stop producing.
// ---------------------------------------------------------------------------

test('resolveCategoryMirror: a flat known name gives that node id and name', async () => {
  const hh = await Household.create({ name: 'H' });
  const dairy = await Category.create({ householdId: hh.id, name: 'Dairy', parentId: null, icon: null });
  assert.deepEqual(await resolveCategoryMirror(hh.id, 'Dairy'), { name: 'Dairy', id: dairy.id });
});

test('resolveCategoryMirror: a path form gives the leaf id and the leaf FLAT name', async () => {
  const hh = await Household.create({ name: 'H' });
  const root = await Category.create({ householdId: hh.id, name: 'Household', parentId: null, icon: null });
  const rent = await Category.create({ householdId: hh.id, name: 'Rent', parentId: root.id, icon: null });
  assert.deepEqual(await resolveCategoryMirror(hh.id, 'Household / Rent'), { name: 'Rent', id: rent.id });
  assert.equal(await Category.count({ where: { householdId: hh.id } }), 2, 'nothing new is created');
});

test('resolveCategoryMirror: an unknown flat name is created and its id returned', async () => {
  const hh = await Household.create({ name: 'H' });
  const mirror = await resolveCategoryMirror(hh.id, 'Sundries');
  assert.equal(mirror.name, 'Sundries');
  const created = await Category.findOne({ where: { householdId: hh.id, name: 'Sundries' } });
  assert.equal(mirror.id, created?.id);
});

test('resolveCategoryMirror: a MALFORMED path re-resolves its leaf, so the FK is never left null', async () => {
  const hh = await Household.create({ name: 'H' });
  const root = await Category.create({ householdId: hh.id, name: 'Household', parentId: null, icon: null });
  const rent = await Category.create({ householdId: hh.id, name: 'Rent', parentId: root.id, icon: null });
  // Every shape that makes parseCategoryPath throw on an empty segment. Step 1
  // returns null for all three; step 2 resolves the leaf segment on its own.
  for (const raw of ['Household // Rent', 'Rent/', '/Rent', 'Household / / Rent']) {
    assert.deepEqual(
      await resolveCategoryMirror(hh.id, raw),
      { name: 'Rent', id: rent.id },
      `${raw} must not persist a flat name with a NULL id`,
    );
  }
  assert.equal(await Category.count({ where: { householdId: hh.id } }), 2, 'nothing new is created');
});

test('resolveCategoryMirror: a malformed path whose leaf is unknown CREATES the leaf and links it', async () => {
  const hh = await Household.create({ name: 'H' });
  const mirror = await resolveCategoryMirror(hh.id, 'Household // Vape');
  assert.equal(mirror.name, 'Vape');
  // Only the leaf is minted — the malformed path says nothing trustworthy about
  // the parent, so no "Household" root is invented from it.
  const rows = await Category.findAll({ where: { householdId: hh.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Vape');
  assert.equal(rows[0].parentId, null);
  assert.equal(mirror.id, rows[0].id);
});

test('resolveCategoryMirror: no household degrades to the leaf segment with a null id', async () => {
  assert.deepEqual(await resolveCategoryMirror(null, 'Household / Rent'), { name: 'Rent', id: null });
  assert.deepEqual(await resolveCategoryMirror(undefined, 'Rent'), { name: 'Rent', id: null });
});

test('resolveCategoryMirror: nothing resolvable at all is a null pair, and writes nothing', async () => {
  const hh = await Household.create({ name: 'H' });
  for (const raw of [null, undefined, '', '   ', '///']) {
    assert.deepEqual(await resolveCategoryMirror(hh.id, raw), { name: null, id: null });
  }
  assert.equal(await Category.count({ where: { householdId: hh.id } }), 0);
});
