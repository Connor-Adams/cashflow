'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('accounts', 'entity_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn('accounts', 'tax_status', {
      type: Sequelize.STRING(32),
      allowNull: false,
      defaultValue: 'n_a',
    });
    await queryInterface.addIndex('accounts', ['entity_id'], {
      name: 'accounts_entity_id',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('accounts', 'accounts_entity_id');
    await queryInterface.removeColumn('accounts', 'tax_status');
    await queryInterface.removeColumn('accounts', 'entity_id');
  },
};
