import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models';

/**
 * Re-assert the invariant that a transaction's entity_id mirrors its account's
 * entity_id. Nothing at the DB level enforces it: after bulk imports or an
 * account→entity reassignment, transactions can carry NULL or a stale entity
 * while their account is correctly tagged, which silently drops them from the
 * T1/T2 tax engine (which keys income off transactions.entity_id).
 *
 * Idempotent: only rows that diverge are touched, and only when the account
 * actually has an entity (`account.entity_id IS NOT NULL`) — we never blank out
 * a txn. Pass a `householdId` to scope the repair (e.g. right after that
 * household's import); omit it to repair globally.
 *
 * Cross-dialect: a correlated subquery (portable between SQLite tests and the
 * Postgres prod DB) plus a dialect-appropriate null-safe inequality operator
 * (`IS NOT` on SQLite, `IS DISTINCT FROM` on Postgres). Returns the number of
 * transaction rows updated.
 */
export async function syncTransactionEntityIds(householdId?: number): Promise<number> {
  const distinctOp = sequelize.getDialect() === 'sqlite' ? 'IS NOT' : 'IS DISTINCT FROM';
  const householdScope = householdId != null ? 'AND a.household_id = :householdId' : '';
  const sql = `
    UPDATE transactions
       SET entity_id = (
         SELECT a.entity_id FROM accounts a WHERE a.id = transactions.account_id
       )
     WHERE account_id IN (
       SELECT a.id
         FROM accounts a
        WHERE a.entity_id IS NOT NULL
          ${householdScope}
     )
       AND entity_id ${distinctOp} (
         SELECT a.entity_id FROM accounts a WHERE a.id = transactions.account_id
       )`;
  const [, affected] = await sequelize.query(sql, {
    type: QueryTypes.UPDATE,
    replacements: householdId != null ? { householdId } : {},
  });
  return typeof affected === 'number' ? affected : 0;
}
