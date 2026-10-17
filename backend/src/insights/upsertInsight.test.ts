import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let upsertInsight: typeof import('./runDetectors').upsertInsight;
let models: typeof import('../models');

before(async () => {
  models = await import('../models');
  sequelize = models.sequelize;
  ({ upsertInsight } = await import('./runDetectors'));
  await sequelize.sync({ force: true });
});
after(async () => { await sequelize.close(); });
beforeEach(async () => {
  await models.Insight.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
});

const finding = (over = {}) => ({
  type: 'subscription_price_increase' as const,
  severity: 'warning' as const,
  title: 'X price increased',
  description: 'desc',
  entityType: 'expectation',
  entityId: 1,
  fingerprint: 'subscription_price_increase:1:1599',
  metadata: { newAmountCents: 1599 },
  ...over,
});

test('upsertInsight creates then refreshes without reopening a dismissed row', async () => {
  const hh = await models.Household.create({ name: 'H' });
  await sequelize.transaction((t) =>
    upsertInsight(hh.id, finding(), { now: new Date('2026-06-01'), userId: null }, t),
  );
  let row = await models.Insight.findOne({ where: { householdId: hh.id } });
  assert.equal(row!.status, 'open');
  await row!.update({ status: 'dismissed' });
  await sequelize.transaction((t) =>
    upsertInsight(hh.id, finding({ title: 'X price increased again' }), { now: new Date('2026-06-02'), userId: null }, t),
  );
  row = await models.Insight.findOne({ where: { householdId: hh.id } });
  assert.equal(row!.status, 'dismissed');
  assert.equal(row!.title, 'X price increased again');
  assert.equal(await models.Insight.count({ where: { householdId: hh.id } }), 1);
});

test('upsertInsight reopens a resolved row whose finding recurs, with refreshed content', async () => {
  const hh = await models.Household.create({ name: 'H' });
  const created = await sequelize.transaction((t) =>
    upsertInsight(hh.id, finding(), { now: new Date('2026-06-01'), userId: null }, t),
  );
  assert.equal(created, 'created');
  let row = await models.Insight.findOne({ where: { householdId: hh.id } });
  assert.equal(row!.status, 'open');

  // Simulate the stale sweep retiring the row: the finding stopped recurring.
  await row!.update({ status: 'resolved' });

  const outcome = await sequelize.transaction((t) =>
    upsertInsight(
      hh.id,
      finding({ title: 'X price increased again', metadata: { newAmountCents: 1699 } }),
      { now: new Date('2026-06-03'), userId: null },
      t,
    ),
  );
  assert.equal(outcome, 'reopened');

  row = await models.Insight.findOne({ where: { householdId: hh.id } });
  assert.equal(row!.status, 'open', 'a resolved row must reopen when its fingerprint recurs');
  assert.equal(row!.title, 'X price increased again');
  assert.deepEqual(row!.metadata, { newAmountCents: 1699 });
  assert.equal(row!.detectedAt.toISOString(), new Date('2026-06-03').toISOString());
  assert.equal(await models.Insight.count({ where: { householdId: hh.id } }), 1);
});

test('upsertInsight leaves an open row open when its finding recurs (no regression)', async () => {
  const hh = await models.Household.create({ name: 'H' });
  await sequelize.transaction((t) =>
    upsertInsight(hh.id, finding(), { now: new Date('2026-06-01'), userId: null }, t),
  );
  const outcome = await sequelize.transaction((t) =>
    upsertInsight(hh.id, finding(), { now: new Date('2026-06-02'), userId: null }, t),
  );
  assert.equal(outcome, 'refreshed');
  const row = await models.Insight.findOne({ where: { householdId: hh.id } });
  assert.equal(row!.status, 'open');
});
