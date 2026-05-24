'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('tax_entities', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: { type: Sequelize.INTEGER, allowNull: false },
      kind: { type: Sequelize.STRING(16), allowNull: false },
      legal_name: { type: Sequelize.STRING(160), allowNull: false },
      jurisdiction: { type: Sequelize.STRING(8), allowNull: false, defaultValue: 'CA-ON' },
      fiscal_year_end: { type: Sequelize.STRING(10), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex('tax_entities', ['household_id', 'kind'], {
      name: 'tax_entities_household_kind',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('tax_entities', 'tax_entities_household_kind');
    await queryInterface.dropTable('tax_entities');
  },
};
