'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('pdf_import_items', 'reason', { type: Sequelize.TEXT, allowNull: true });
    await queryInterface.addColumn('pdf_import_batches', 'skipped', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn('pdf_import_batches', 'started_at', { type: Sequelize.DATE, allowNull: true });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('pdf_import_items', 'reason');
    await queryInterface.removeColumn('pdf_import_batches', 'skipped');
    await queryInterface.removeColumn('pdf_import_batches', 'started_at');
  },
};
