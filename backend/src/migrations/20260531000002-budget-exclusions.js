'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

/**
 * Adds the budget_exclusions join table introduced in issue #201.
 *
 * Use case: a user wants a transaction to NOT count against a particular
 * budget. Examples: a one-off bulk-cost ('I bought a $2000 fridge but it
 * shouldn't blow my Home budget for the month') or a refunded charge that
 * should disappear from the budget view entirely. We capture per-budget
 * exclusions (not global) so the same transaction can still count
 * elsewhere — e.g. it's excluded from "Home" but still counted in
 * "Overall".
 *
 * The unique (budget_id, transaction_id) constraint keeps the join
 * idempotent — POSTing the same exclusion twice is a no-op, not a
 * duplicate row.
 */

async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('budget_exclusions', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      budget_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'budget_targets', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      transaction_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'transactions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(queryInterface, 'budget_exclusions', ['budget_id'], {
      name: 'budget_exclusions_budget_id',
    });
    await addIndex(queryInterface, 'budget_exclusions', ['transaction_id'], {
      name: 'budget_exclusions_transaction_id',
    });
    await addIndex(
      queryInterface,
      'budget_exclusions',
      ['budget_id', 'transaction_id'],
      {
        name: 'budget_exclusions_budget_transaction_unique',
        unique: true,
      }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('budget_exclusions');
  },
};
