'use strict';

/**
 * Adds FOREIGN KEYs from accounts.entity_id and transactions.entity_id to
 * tax_entities(id). entity_id drives the T1/T2 tax engine — a row with a
 * dangling or wrong entity_id is silently mis-attributed (see PR #526), so
 * the DB should refuse references that don't point at a real entity.
 *
 * ON DELETE SET NULL (not RESTRICT/NO ACTION): it mirrors the repo convention
 * for optional cross-references (owner_user_id, ownership_contact_id,
 * applied_rule_id, linked_transaction_id are all SET NULL) and, crucially,
 * does not block the `households` ON DELETE CASCADE teardown —
 * accounts.household_id / transactions.household_id are CASCADE, and a
 * RESTRICT entity FK could abort that cascade depending on delete ordering.
 * ON UPDATE CASCADE keeps references correct if a tax_entities id is ever
 * renumbered.
 *
 * entity_id stays NULLABLE. A NOT NULL constraint is deliberately deferred:
 * the best-effort creation hooks swallow a missing-household FK, and the raw
 * INSERT restore path (backend/src/sync/restoreBundle.ts) can transiently
 * carry NULL — so "no new NULLs" cannot yet be guaranteed at the DB level.
 *
 * Dialect notes:
 *   - Postgres (prod): real ALTER TABLE ADD CONSTRAINT via raw SQL.
 *   - SQLite (tests): cannot ALTER TABLE ADD CONSTRAINT without a full table
 *     rebuild, which the repo deliberately avoids (see
 *     20260524210000-stable-identity-fingerprint). On SQLite this migration is
 *     a no-op; the referential intent is carried by the Account/Transaction
 *     belongsTo(Entity) associations in models/index.ts, and the real FK is
 *     enforced on Postgres only. The integration suite runs the whole
 *     migration chain against Postgres, exercising the DDL below.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    if (sequelize.getDialect() !== 'postgres') return;
    await sequelize.query(
      'ALTER TABLE accounts ADD CONSTRAINT accounts_entity_id_fkey ' +
        'FOREIGN KEY (entity_id) REFERENCES tax_entities(id) ' +
        'ON UPDATE CASCADE ON DELETE SET NULL',
    );
    await sequelize.query(
      'ALTER TABLE transactions ADD CONSTRAINT transactions_entity_id_fkey ' +
        'FOREIGN KEY (entity_id) REFERENCES tax_entities(id) ' +
        'ON UPDATE CASCADE ON DELETE SET NULL',
    );
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    if (sequelize.getDialect() !== 'postgres') return;
    await sequelize.query(
      'ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_entity_id_fkey',
    );
    await sequelize.query(
      'ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_entity_id_fkey',
    );
  },
};
