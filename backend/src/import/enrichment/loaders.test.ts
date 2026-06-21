/**
 * The recurring-history and relationship-candidate loaders are called from
 * INSIDE the import DB transaction (runImport.ts / commitStatementImport.ts).
 * On Postgres each raw sequelize.query runs on its own pooled connection, so
 * unless the loader threads the caller's transaction handle, rows inserted
 * earlier in the same import are invisible (READ COMMITTED) — same-statement
 * refund/transfer pairs then link on SQLite but not in prod. These tests pin
 * the transaction option being forwarded to sequelize.query.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Transaction as SequelizeTransaction } from 'sequelize';
import { sequelize } from '../../models';
import { loadRecurringHistory, loadRelationshipCandidates } from './loaders';

const realQuery = sequelize.query.bind(sequelize);

afterEach(() => {
  (sequelize as { query: unknown }).query = realQuery;
});

function captureQueryOptions(): { options: Record<string, unknown> | null } {
  const captured: { options: Record<string, unknown> | null } = { options: null };
  (sequelize as { query: unknown }).query = async (
    _sql: string,
    options: Record<string, unknown>,
  ) => {
    captured.options = options;
    return [];
  };
  return captured;
}

test('loadRecurringHistory forwards the caller transaction to sequelize.query', async () => {
  const captured = captureQueryOptions();
  const fakeTxn = { id: 'fake-txn' } as unknown as SequelizeTransaction;

  await loadRecurringHistory(1, 'Netflix', '2026-01-15', fakeTxn);

  assert.ok(captured.options, 'query was issued');
  assert.equal(captured.options!.transaction, fakeTxn);
});

test('loadRelationshipCandidates forwards the caller transaction to sequelize.query', async () => {
  const captured = captureQueryOptions();
  const fakeTxn = { id: 'fake-txn' } as unknown as SequelizeTransaction;

  await loadRelationshipCandidates(1, [1, 2], 'Netflix', '2026-01-15', 30, fakeTxn);

  assert.ok(captured.options, 'query was issued');
  assert.equal(captured.options!.transaction, fakeTxn);
});

test('loaders stay transaction-less when no transaction is passed', async () => {
  const captured = captureQueryOptions();

  await loadRecurringHistory(1, 'Netflix', '2026-01-15');

  assert.ok(captured.options, 'query was issued');
  assert.equal(captured.options!.transaction, undefined);
});
