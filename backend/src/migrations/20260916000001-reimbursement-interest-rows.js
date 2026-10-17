'use strict';

/**
 * People ledger phase 2. Lets a Reimbursement represent allocated line-of-credit
 * interest as well as principal.
 *
 *   - kind STRING(16) NOT NULL DEFAULT 'principal': 'principal' | 'interest'.
 *     Existing rows are principal by definition — they were hand-logged claims.
 *   - source_transaction_id INTEGER NULL: the LOAN INTEREST charge an interest
 *     row was derived from. Null for principal rows.
 *
 * The partial unique index on (source_transaction_id, contact_id) is what makes
 * the allocator idempotent: re-running it recomputes rather than stacking a
 * second charge on the same contact for the same month. Partial so the many
 * principal rows, which share a null source, do not collide.
 *
 * Spine note: discriminator + provenance fields on the existing Expectation
 * primitive (physical table `reimbursements`). No new primitive.
 *
 * Dialect-agnostic: runs on SQLite and Postgres.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('reimbursements', 'kind', {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'principal',
    });
    await queryInterface.addColumn('reimbursements', 'source_transaction_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addIndex('reimbursements', ['source_transaction_id', 'contact_id'], {
      unique: true,
      name: 'idx_reimbursements_interest_source',
      where: { source_transaction_id: { [Sequelize.Op.ne]: null } },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('reimbursements', 'idx_reimbursements_interest_source');
    await queryInterface.removeColumn('reimbursements', 'source_transaction_id');
    await queryInterface.removeColumn('reimbursements', 'kind');
  },
};
