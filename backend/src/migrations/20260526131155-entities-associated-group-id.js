'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('tax_entities', 'associated_group_id', {
      type: Sequelize.STRING(64),
      allowNull: true,
    });
    await queryInterface.addIndex('tax_entities', ['associated_group_id']);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('tax_entities', 'associated_group_id');
  },
};
