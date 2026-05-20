'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('partner_settlements', {
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
      contact_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'contacts', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      direction: {
        type: Sequelize.STRING(32),
        allowNull: false,
      },
      currency: {
        type: Sequelize.STRING(3),
        allowNull: false,
      },
      amount: {
        type: Sequelize.DECIMAL(14, 4),
        allowNull: false,
      },
      settled_date: {
        type: Sequelize.DATEONLY,
        allowNull: false,
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex('partner_settlements', ['household_id'], {
      name: 'partner_settlements_household_id',
    });
    await queryInterface.addIndex('partner_settlements', ['contact_id'], {
      name: 'partner_settlements_contact_id',
    });
    await queryInterface.addIndex(
      'partner_settlements',
      ['household_id', 'settled_date'],
      { name: 'partner_settlements_household_settled_date' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('partner_settlements');
  },
};
