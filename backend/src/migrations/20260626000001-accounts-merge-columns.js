'use strict';

/**
 * Account merge / consolidation (Cashflow #287). Adds the soft-merge audit
 * columns to `accounts`:
 *
 *   - merged_into_id  BIGINT NULL  FK -> accounts(id) ON DELETE RESTRICT
 *   - merged_at       TIMESTAMP NULL
 *
 * plus an index on (merged_into_id) for the "find sources merged into me"
 * lookup. When merged_into_id is set the source account is a merged duplicate:
 * its transactions / planned events have been reassigned to the target and the
 * row is excluded from the default GET /api/accounts list.
 *
 * Spine note: this EXTENDS the existing Account primitive with a
 * self-referential soft-merge field — it is NOT a new primitive. Merge is a
 * behaviour/lifecycle on Account, not a new status machine wearing a new shape.
 *
 * Reversible: down() drops the index then both columns.
 *
 * Dual-dialect: the FK reference is enforced on Postgres; SQLite ignores a FK
 * added via ALTER TABLE (it cannot rebuild the table here), so the
 * target-deletion guard also lives in application code (routes/accounts.ts
 * blocks deleting an account that still has merged sources pointing at it).
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('accounts', 'merged_into_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null,
      references: { model: 'accounts', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    });
    await queryInterface.addColumn('accounts', 'merged_at', {
      type: Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addIndex('accounts', ['merged_into_id'], {
      name: 'accounts_merged_into_id',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('accounts', 'accounts_merged_into_id');
    await queryInterface.removeColumn('accounts', 'merged_at');
    await queryInterface.removeColumn('accounts', 'merged_into_id');
  },
};
