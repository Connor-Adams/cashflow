import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let AiSuggestion: typeof import('../models').AiSuggestion;
let findPastCorrections: typeof import('./pastCorrections').findPastCorrections;

before(async () => {
  const models = await import('../models');
  sequelize = models.sequelize;
  AiSuggestion = models.AiSuggestion;
  ({ findPastCorrections } = await import('./pastCorrections'));
  await sequelize.sync({ force: true });
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await AiSuggestion.destroy({ where: {}, truncate: true });
});

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

test('a split-percentage-only edit surfaces the pctMe change', async () => {
  // The user kept category/business/splitType as suggested and only changed
  // the split percentage. Before the fix, CorrectionFields dropped pctMe
  // entirely, so `suggested` and `corrected` were identical here even though
  // `mismatchedFields` (built from METRIC_TO_FIELD) already named 'pctMe' —
  // an incoherent record that would teach the prompt nothing.
  await seed({
    output: { category: 'Dining', business: false, splitType: 'shared', pctMe: 50 },
    finalSnapshot: {
      category: 'Dining',
      business: false,
      splitType: 'shared',
      pctMe: '70', // stored as a numeric string, as this codebase does elsewhere
      metrics: {
        categoryMatch: true,
        businessMatch: true,
        splitTypeMatch: true,
        pctMeMatch: false,
      },
    },
  });
  const out = await findPastCorrections(1, 'Starbucks 123');
  assert.equal(out.length, 1);
  assert.equal(out[0].suggested.pctMe, 50);
  assert.equal(out[0].corrected.pctMe, 70);
  assert.notEqual(out[0].suggested.pctMe, out[0].corrected.pctMe);
  assert.ok(out[0].mismatchedFields.includes('pctMe'));
});
