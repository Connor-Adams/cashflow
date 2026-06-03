'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('tax_entities', 'currency', {
      type: Sequelize.STRING(3),
      allowNull: false,
      defaultValue: 'CAD',
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('tax_entities', 'currency');
  },
};
