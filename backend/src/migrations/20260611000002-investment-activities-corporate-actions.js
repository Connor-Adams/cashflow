'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('investment_activities', 'recipient_security_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'securities', key: 'id' },
      onDelete: 'SET NULL',
    });
    await queryInterface.addColumn('investment_activities', 'cost_basis_allocation_pct', {
      type: Sequelize.DECIMAL(5, 4),
      allowNull: true,
    });
    await queryInterface.addColumn('investment_activities', 'cash_component', {
      type: Sequelize.DECIMAL(18, 4),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('investment_activities', 'cash_component');
    await queryInterface.removeColumn('investment_activities', 'cost_basis_allocation_pct');
    await queryInterface.removeColumn('investment_activities', 'recipient_security_id');
  },
};
