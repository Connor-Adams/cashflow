'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('rules', 'effective_from', {
      type: Sequelize.DATEONLY,
      allowNull: true,
    });
    await queryInterface.addColumn('rules', 'effective_to', {
      type: Sequelize.DATEONLY,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('rules', 'effective_to');
    await queryInterface.removeColumn('rules', 'effective_from');
  },
};
