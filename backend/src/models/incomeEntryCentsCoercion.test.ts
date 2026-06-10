import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let IncomeEntry: typeof import('./IncomeEntry').IncomeEntry;

before(async () => {
  const models = await import('./');
  ({ sequelize, IncomeEntry } = models);
  await sequelize.sync({ force: true });
});
after(async () => {
  await sequelize.close();
});

async function createEntry() {
  return IncomeEntry.create({
    userId: 1,
    householdId: 1,
    occurredOn: '2026-01-15',
    grossAmountCents: 250000,
    currency: 'CAD',
    taxWithheldCents: 70000,
    netAmountCents: 180000,
    source: 'paycheck',
  });
}

/**
 * Simulate the pg driver: with no INT8 type parser installed, Postgres
 * hydrates BIGINT columns as strings. SQLite returns numbers, so without
 * this simulation the bug is invisible to unit tests.
 */
function hydrateAsStrings(entry: InstanceType<typeof IncomeEntry>) {
  entry.setDataValue('id', '7' as unknown as number);
  entry.setDataValue('grossAmountCents', '250000' as unknown as number);
  entry.setDataValue('taxWithheldCents', '70000' as unknown as number);
  entry.setDataValue('netAmountCents', '180000' as unknown as number);
}

test('BIGINT cents read as numbers even when the driver returns strings', async () => {
  const entry = await createEntry();
  hydrateAsStrings(entry);

  assert.strictEqual(entry.grossAmountCents, 250000);
  assert.strictEqual(entry.taxWithheldCents, 70000);
  assert.strictEqual(entry.netAmountCents, 180000);
  assert.strictEqual(entry.id, 7);
});

test('toJSON (what res.json serializes) emits numeric cents, not strings', async () => {
  const entry = await createEntry();
  hydrateAsStrings(entry);

  const json = entry.toJSON() as Record<string, unknown>;
  assert.strictEqual(json.grossAmountCents, 250000);
  assert.strictEqual(json.taxWithheldCents, 70000);
  assert.strictEqual(json.netAmountCents, 180000);
  assert.strictEqual(json.id, 7);
});

test('null taxWithheldCents stays null (not coerced to 0)', async () => {
  const entry = await IncomeEntry.create({
    userId: 1,
    householdId: 1,
    occurredOn: '2026-02-01',
    grossAmountCents: 100000,
    currency: 'CAD',
    taxWithheldCents: null,
    netAmountCents: 100000,
    source: 'invoice',
  });
  assert.strictEqual(entry.taxWithheldCents, null);
  const json = entry.toJSON() as Record<string, unknown>;
  assert.strictEqual(json.taxWithheldCents, null);
});

test('PATCH merge precondition: entry cents are numbers so partial updates revalidate', async () => {
  // routes/income.ts PATCH merges entry.grossAmountCents back through
  // validateInput, which requires typeof === 'number'. String-hydrated rows
  // (Postgres) used to 400 every partial update.
  const entry = await createEntry();
  hydrateAsStrings(entry);
  assert.strictEqual(typeof entry.grossAmountCents, 'number');
  assert.strictEqual(Number.isInteger(entry.grossAmountCents), true);
});
