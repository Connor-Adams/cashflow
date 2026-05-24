'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('tax_categories', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      code: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      label: { type: Sequelize.STRING(160), allowNull: false },
      t1_line: { type: Sequelize.STRING(8), allowNull: true },
      t2_schedule: { type: Sequelize.STRING(8), allowNull: true },
      t2_line: { type: Sequelize.STRING(8), allowNull: true },
      is_deductible: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      business_use_default: { type: Sequelize.DECIMAL(5, 2), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('tax_categories');
  },
};
