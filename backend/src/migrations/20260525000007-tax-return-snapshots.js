'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const isPostgres = queryInterface.sequelize.getDialect() === 'postgres';
    await queryInterface.createTable('tax_return_snapshots', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      entity_id: { type: Sequelize.INTEGER, allowNull: false },
      year: { type: Sequelize.INTEGER, allowNull: false },
      computed_at: { type: Sequelize.DATE, allowNull: false },
      facts_hash: { type: Sequelize.STRING(64), allowNull: false },
      lines: {
        type: isPostgres ? Sequelize.JSONB : Sequelize.JSON,
        allowNull: false,
      },
      totals: {
        type: isPostgres ? Sequelize.JSONB : Sequelize.JSON,
        allowNull: false,
      },
      warnings: {
        type: isPostgres ? Sequelize.JSONB : Sequelize.JSON,
        allowNull: false,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('tax_return_snapshots', ['entity_id', 'year'], {
      name: 'tax_return_snapshots_entity_year',
      unique: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex(
      'tax_return_snapshots',
      'tax_return_snapshots_entity_year'
    );
    await queryInterface.dropTable('tax_return_snapshots');
  },
};
