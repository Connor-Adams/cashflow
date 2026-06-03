'use strict';

/**
 * Makes accounts.entity_id and transactions.entity_id NOT NULL — the
 * originally-approved design item 9, deliberately deferred in PR #527
 * (20260618000001-entity-id-foreign-keys).
 *
 * Why now: entity_id drives the T1/T2 tax engine (buildPersonalFacts /
 * buildCorpFacts query `where entityId=...`), so a NULL silently drops the row
 * from every tax calculation. The fill hooks (Account.fillPersonalEntity /
 * Transaction.inheritEntityFromAccount) populate it on create, and PR #527 made
 * the restore path re-derive it post-insert; this constraint is the defense in
 * depth that turns a future silent-NULL into a loud insert failure. Prod was
 * verified to hold 0 NULL entity_id (26 accounts / 3064 transactions,
 * 2026-06-02) before shipping, so SET NOT NULL cannot fail on backfill.
 *
 * The FK must change from ON DELETE SET NULL to ON DELETE NO ACTION:
 *   - SET NULL is incompatible with NOT NULL — deleting a referenced
 *     tax_entity would try to write NULL into a NOT NULL column and error
 *     anyway. NO ACTION instead blocks the delete with a clean foreign-key
 *     violation ("reassign the accounts first"), the correct semantics for a
 *     mandatory entity_id.
 *   - NO ACTION (not RESTRICT): NO ACTION defers the FK check to the end of the
 *     statement, so a cascade that deletes the referencing rows in the same
 *     statement still passes; RESTRICT checks immediately and can abort it.
 *   - This does NOT block the `households` ON DELETE CASCADE teardown:
 *     tax_entities has no household FK (see 20260525000001-tax-entities.js), so
 *     deleting a household cascade-deletes its accounts/transactions
 *     (household_id is CASCADE) but never deletes a tax_entity — the entity FK
 *     never fires during teardown. PR #527's worry that RESTRICT/NO ACTION
 *     could abort the cascade does not apply. (Exercised by the Postgres
 *     integration test test/integration/entityIdNotNull.test.ts.)
 *
 * Dialect notes (mirrors 20260618000001 / 20260524210000):
 *   - Postgres (prod): real DDL below.
 *   - SQLite (tests): a no-op. SQLite cannot ALTER COLUMN ... SET NOT NULL or
 *     swap a constraint without a full table rebuild, which the repo avoids.
 *     The Sequelize model field is deliberately left allowNull:true (NOT
 *     allowNull:false): the fill hooks run on beforeCreate, AFTER Sequelize
 *     validation, so an allowNull:false field would reject every create before
 *     the hook fills entity_id. Enforcement is therefore Postgres-only; the
 *     model belongsTo(Entity) association carries the intent on SQLite. The
 *     integration suite runs the whole migration chain against Postgres.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    if (sequelize.getDialect() !== 'postgres') return;

    // 1. Swap ON DELETE SET NULL -> ON DELETE NO ACTION (keep ON UPDATE CASCADE).
    await sequelize.query(
      'ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_entity_id_fkey',
    );
    await sequelize.query(
      'ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_entity_id_fkey',
    );
    await sequelize.query(
      'ALTER TABLE accounts ADD CONSTRAINT accounts_entity_id_fkey ' +
        'FOREIGN KEY (entity_id) REFERENCES tax_entities(id) ' +
        'ON UPDATE CASCADE ON DELETE NO ACTION',
    );
    await sequelize.query(
      'ALTER TABLE transactions ADD CONSTRAINT transactions_entity_id_fkey ' +
        'FOREIGN KEY (entity_id) REFERENCES tax_entities(id) ' +
        'ON UPDATE CASCADE ON DELETE NO ACTION',
    );

    // 2. Enforce NOT NULL (prod verified 0 NULL before shipping).
    await sequelize.query(
      'ALTER TABLE accounts ALTER COLUMN entity_id SET NOT NULL',
    );
    await sequelize.query(
      'ALTER TABLE transactions ALTER COLUMN entity_id SET NOT NULL',
    );
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    if (sequelize.getDialect() !== 'postgres') return;

    // Reverse order: relax NOT NULL, then restore the SET NULL FK.
    await sequelize.query(
      'ALTER TABLE transactions ALTER COLUMN entity_id DROP NOT NULL',
    );
    await sequelize.query(
      'ALTER TABLE accounts ALTER COLUMN entity_id DROP NOT NULL',
    );
    await sequelize.query(
      'ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_entity_id_fkey',
    );
    await sequelize.query(
      'ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_entity_id_fkey',
    );
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
};
