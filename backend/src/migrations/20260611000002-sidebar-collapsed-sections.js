'use strict';

/**
 * Adds `sidebar_collapsed_sections` (JSONB, not null, default '[]') to
 * `cashflow_settings` for issue #290 (collapsible sidebar sections).
 *
 * Stores the array of section IDs the user has collapsed so the state
 * survives page reloads and is shared across devices. Valid section IDs:
 * 'today', 'money', 'planning', 'investments', 'insights-rules'.
 *
 * Fully reversible: `down` drops the column with no data dependency.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(
      'cashflow_settings',
      'sidebar_collapsed_sections',
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
      'sidebar_collapsed_sections',
    );
  },
};
