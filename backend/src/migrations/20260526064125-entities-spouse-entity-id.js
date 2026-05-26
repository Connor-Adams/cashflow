'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('tax_entities', 'spouse_entity_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'tax_entities', key: 'id' },
      onDelete: 'SET NULL',
    });
    await queryInterface.addIndex('tax_entities', ['spouse_entity_id']);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('tax_entities', 'spouse_entity_id');
  },
};
