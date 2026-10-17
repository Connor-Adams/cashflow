import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, ExternalOrder } from './index';
import {
  findExternalOrderForDedupe,
  findOrCreateExternalOrderForDedupe,
} from './externalOrderDedupe';

before(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await ExternalOrder.destroy({ where: {}, truncate: true, force: true });
});

test('returns null when no row matches, soft-deleted or not', async () => {
  const found = await findExternalOrderForDedupe({ householdId: 1, dedupeKey: 'missing' });
  assert.equal(found, null);
});

test('returns a live row unchanged', async () => {
  const row = await ExternalOrder.create({
    householdId: 1, vendor: 'amazon', dedupeKey: 'k1',
    total: '10.00', currency: 'CAD', source: 'test',
  } as never);
  const found = await findExternalOrderForDedupe({ householdId: 1, dedupeKey: 'k1' });
  assert.equal(found?.id, row.id);
  assert.equal(found?.deletedAt, null);
});

test('finds and restores a soft-deleted row instead of missing it', async () => {
  const row = await ExternalOrder.create({
    householdId: 1, vendor: 'amazon', dedupeKey: 'k2',
    total: '10.00', currency: 'CAD', source: 'test',
  } as never);
  await row.destroy(); // simulates mergeDuplicateAmazonOrders soft-deleting a loser

  // A plain (paranoid) findOne must not see it -- sanity check the premise.
  const plain = await ExternalOrder.findOne({ where: { householdId: 1, dedupeKey: 'k2' } });
  assert.equal(plain, null);

  const found = await findExternalOrderForDedupe({ householdId: 1, dedupeKey: 'k2' });
  assert.ok(found, 'the soft-deleted row must be found, not missed');
  assert.equal(found!.id, row.id);
  assert.equal(found!.deletedAt, null, 'it must be restored (visible again), not merely located');

  const visibleAgain = await ExternalOrder.findByPk(row.id);
  assert.ok(visibleAgain, 'a normal query must now see the restored row');
});

test('restoring inside a transaction rolls back with it', async () => {
  const row = await ExternalOrder.create({
    householdId: 1, vendor: 'amazon', dedupeKey: 'k3',
    total: '10.00', currency: 'CAD', source: 'test',
  } as never);
  await row.destroy();

  await assert.rejects(
    sequelize.transaction(async (t) => {
      const found = await findExternalOrderForDedupe({ householdId: 1, dedupeKey: 'k3' }, t);
      assert.ok(found);
      assert.equal(found!.deletedAt, null);
      throw new Error('force rollback');
    }),
  );

  // The restore must not have survived the rolled-back transaction.
  const stillDeleted = await ExternalOrder.findOne({
    where: { householdId: 1, dedupeKey: 'k3' },
    paranoid: false,
  });
  assert.ok(stillDeleted?.deletedAt, 'the restore must roll back with its transaction');
});

test('findOrCreateExternalOrderForDedupe creates when nothing matches', async () => {
  const [order, created] = await findOrCreateExternalOrderForDedupe({
    where: { householdId: 1, dedupeKey: 'foc-1' },
    defaults: {
      householdId: 1, vendor: 'amazon', dedupeKey: 'foc-1',
      total: '10.00', currency: 'CAD', source: 'test',
    },
  });
  assert.equal(created, true);
  assert.equal(order.dedupeKey, 'foc-1');
});

test('findOrCreateExternalOrderForDedupe returns the live row without re-creating', async () => {
  const row = await ExternalOrder.create({
    householdId: 1, vendor: 'amazon', dedupeKey: 'foc-2',
    total: '10.00', currency: 'CAD', source: 'test',
  } as never);
  const [order, created] = await findOrCreateExternalOrderForDedupe({
    where: { householdId: 1, dedupeKey: 'foc-2' },
    defaults: {
      householdId: 1, vendor: 'amazon', dedupeKey: 'foc-2',
      total: '999.00', currency: 'CAD', source: 'test',
    },
  });
  assert.equal(created, false);
  assert.equal(order.id, row.id);
  assert.equal(Number(order.total), 10, 'must not overwrite the existing row with defaults');
});

test('findOrCreateExternalOrderForDedupe restores a soft-deleted row instead of throwing on the unique index', async () => {
  const row = await ExternalOrder.create({
    householdId: 1, vendor: 'amazon', dedupeKey: 'foc-3',
    total: '10.00', currency: 'CAD', source: 'test',
  } as never);
  await row.destroy();

  const [order, created] = await findOrCreateExternalOrderForDedupe({
    where: { householdId: 1, dedupeKey: 'foc-3' },
    defaults: {
      householdId: 1, vendor: 'amazon', dedupeKey: 'foc-3',
      total: '10.00', currency: 'CAD', source: 'test',
    },
  });
  assert.equal(created, false);
  assert.equal(order.id, row.id);
  assert.equal(order.deletedAt, null);

  const count = await ExternalOrder.count({ where: { householdId: 1, dedupeKey: 'foc-3' } });
  assert.equal(count, 1, 'must not have created a second, colliding row');
});
