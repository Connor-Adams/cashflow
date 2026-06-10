/**
 * findMerchantMemory is called from inside the import DB transaction; like the
 * enrichment loaders it must forward the caller's transaction handle to
 * sequelize.query so all in-transaction reads use the same connection.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Transaction as SequelizeTransaction } from 'sequelize';
import { sequelize } from '../models';
import { findMerchantMemory } from './merchantMemory';

const realQuery = sequelize.query.bind(sequelize);

afterEach(() => {
  (sequelize as { query: unknown }).query = realQuery;
});

test('findMerchantMemory forwards the caller transaction to sequelize.query', async () => {
  const capturedOptions: Record<string, unknown>[] = [];
  (sequelize as { query: unknown }).query = async (
    _sql: string,
    options: Record<string, unknown>,
  ) => {
    capturedOptions.push(options);
    return [];
  };
  const fakeTxn = { id: 'fake-txn' } as unknown as SequelizeTransaction;

  await findMerchantMemory(1, 'Netflix', -15.49, { transaction: fakeTxn });

  assert.ok(capturedOptions.length > 0, 'at least one query was issued');
  for (const options of capturedOptions) {
    assert.equal(options.transaction, fakeTxn);
  }
});
