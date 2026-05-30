module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('investment_activities', 'recipient_security_id', {
      type: Sequelize.BIGINT,
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn('investment_activities', 'cost_basis_allocation_pct', {
      type: Sequelize.DECIMAL(5, 4),
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn('investment_activities', 'cash_component', {
      type: Sequelize.DECIMAL(18, 4),
      allowNull: true,
      defaultValue: null,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('investment_activities', 'recipient_security_id');
    await queryInterface.removeColumn('investment_activities', 'cost_basis_allocation_pct');
    await queryInterface.removeColumn('investment_activities', 'cash_component');
  },
};
