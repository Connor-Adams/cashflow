'use strict';

/**
 * Add `from_split` to reimbursements: marks a claim created by the multiway
 * transaction-split action (vs. a manually-created claim). Lets the split
 * action replace only its own claims when a transaction is re-split, leaving
 * ad-hoc claims untouched. Boolean NOT NULL default false (existing rows
 * backfill to false).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('reimbursements', 'from_split', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('reimbursements', 'from_split');
  },
};
