import { randomBytes } from 'node:crypto';
import type { Transaction as SqlTransaction } from 'sequelize';
import { sequelize } from '../db';

/**
 * Run a best-effort write inside a SAVEPOINT of the caller's transaction, so the
 * caller can catch its failure without losing everything else in `outer`.
 *
 * Catching the error is not enough on Postgres. A failed statement aborts the
 * whole transaction: every later statement fails with "current transaction is
 * aborted, commands ignored until end of transaction block", and the eventual
 * COMMIT is answered with ROLLBACK. So a
 * `try { await X.create(..., { transaction }) } catch { log }` inside someone
 * else's transaction silently discards the very change it meant to protect.
 * SQLite keeps the transaction alive after a failed statement, so a SQLite unit
 * test never shows this.
 *
 * On failure this issues `ROLLBACK TO SAVEPOINT`, which clears Postgres's
 * aborted state, then rethrows. Catch OUTSIDE this call: a catch inside `fn`
 * swallows the error before the savepoint is rolled back. On success the
 * savepoint is RELEASEd, folding its work into `outer`.
 *
 * Why not `sequelize.transaction({ transaction: outer }, fn)`: Sequelize 6 names
 * a nested savepoint `${rootId}-sp-${parent.savepoints.length}`, counting per
 * parent, so a savepoint opened inside the first savepoint of a transaction gets
 * its parent's exact name. Postgres and SQLite resolve `ROLLBACK TO SAVEPOINT`
 * to the most recent savepoint of that name, so when the enclosing savepoint
 * later rolls back it rewinds only to the inner one and keeps the writes made
 * before it. It also never RELEASEs a nested savepoint. A random name sidesteps
 * both (see inSavepoint.test.ts).
 *
 * Likewise do not lean on `Model.findOrCreate` for this: given an outer
 * transaction it opens a Sequelize-named savepoint and rolls it back only for a
 * unique violation.
 *
 * With no outer transaction `fn` runs directly (autocommit), where a failed
 * statement affects nothing else.
 */
export async function inSavepoint<T>(
  outer: SqlTransaction | null | undefined,
  fn: (transaction: SqlTransaction | undefined) => Promise<T>,
): Promise<T> {
  if (!outer) return fn(undefined);
  // Unquoted-safe on both dialects: letters, digits, underscore.
  const name = `cf_sp_${randomBytes(8).toString('hex')}`;
  await sequelize.query(`SAVEPOINT ${name}`, { transaction: outer });
  let result: T;
  try {
    result = await fn(outer);
  } catch (err) {
    await sequelize.query(`ROLLBACK TO SAVEPOINT ${name}`, { transaction: outer });
    await sequelize.query(`RELEASE SAVEPOINT ${name}`, { transaction: outer });
    throw err;
  }
  await sequelize.query(`RELEASE SAVEPOINT ${name}`, { transaction: outer });
  return result;
}
