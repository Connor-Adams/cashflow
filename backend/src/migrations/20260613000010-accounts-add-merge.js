'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('accounts', 'merged_into_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null,
      references: { model: 'accounts', key: 'id' },
      onDelete: 'RESTRICT',
    });
    await queryInterface.addColumn('accounts', 'merged_at', {
      type: Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addIndex('accounts', ['merged_into_id'], {
      name: 'accounts_merged_into_id_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('accounts', 'accounts_merged_into_id_idx');
    await queryInterface.removeColumn('accounts', 'merged_at');
    await queryInterface.removeColumn('accounts', 'merged_into_id');
  },
};
