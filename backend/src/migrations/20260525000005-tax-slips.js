'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const isPostgres = queryInterface.sequelize.getDialect() === 'postgres';
    await queryInterface.createTable('tax_slips', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      entity_id: { type: Sequelize.INTEGER, allowNull: false },
      year: { type: Sequelize.INTEGER, allowNull: false },
      slip_type: { type: Sequelize.STRING(8), allowNull: false }, // T4|T5|T3|T4A|T5008
      issuer: { type: Sequelize.STRING(256), allowNull: false },
      box_values: {
        type: isPostgres ? Sequelize.JSONB : Sequelize.JSON,
        allowNull: false,
      },
      source_doc_id: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('tax_slips', ['entity_id', 'year'], {
      name: 'tax_slips_entity_year',
    });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex('tax_slips', 'tax_slips_entity_year');
    await queryInterface.dropTable('tax_slips');
  },
};
