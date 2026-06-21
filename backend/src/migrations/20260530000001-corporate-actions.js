'use strict';

// Adds the corporate-action columns to investment_activities (issue #301) so
// the ACB engine and the manual activity endpoint can record spin-offs,
// mergers, dividends in kind, and returns of capital:
//
//   recipient_security_id    — for spin_off / merger: the security received.
//   cost_basis_allocation_pct — for spin_off: fraction of the original basis
//                               allocated to the new security (0..1).
//   cash_component           — for merger: cash per share received in addition
//                               to the new security.
//
// All nullable — existing rows and the existing buy/sell/split/DRIP activity
// types do not populate them.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('investment_activities', 'recipient_security_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
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
