'use strict';

/**
 * Adds `dismissed_activation_cards` (JSONB, not null, default '[]') to
 * `cashflow_settings` for issue #274 (dashboard next-action card deck).
 *
 * Stores the array of card IDs the user has dismissed so the state
 * persists across sessions and devices. Valid card IDs:
 * 'import' | 'review' | 'budget' | 'goal' | 'invite'.
 *
 * Fully reversible: `down` drops the column with no data dependency.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(
      'cashflow_settings',
      'dismissed_activation_cards',
      {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: [],
      },
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn(
      'cashflow_settings',
      'dismissed_activation_cards',
    );
  },
};
