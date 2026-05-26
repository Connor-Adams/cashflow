'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

/**
 * Adds `exclude_refunded_purchases` (BOOLEAN, default false) to budget_targets
 * for issue #215.
 *
 * When true, the budget progress route subtracts the linked-original-purchase
 * amounts of all matched refunds within the period bounds, so a customer
 * returning a $200 jacket bought in the same month effectively zeros that
 * spend (currently the refund nets via dashboard credits, but the original
 * purchase still counts against the budget gross-outflow target).
 *
 * Defaults to false to preserve legacy behavior.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('budget_targets', 'exclude_refunded_purchases', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('budget_targets', 'exclude_refunded_purchases');
  },
};
