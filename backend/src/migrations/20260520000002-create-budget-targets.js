'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('budget_targets', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      category: {
        type: Sequelize.STRING(128),
        allowNull: true,
      },
      currency: {
        type: Sequelize.STRING(3),
        allowNull: false,
      },
      amount: {
        type: Sequelize.DECIMAL(14, 4),
        allowNull: false,
      },
      period: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'monthly',
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(queryInterface, 'budget_targets', ['household_id'], {
      name: 'budget_targets_household_id',
    });
    await addIndex(
      queryInterface,
      'budget_targets',
      ['household_id', 'currency', 'category'],
      { name: 'budget_targets_household_currency_category' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('budget_targets');
  },
};
