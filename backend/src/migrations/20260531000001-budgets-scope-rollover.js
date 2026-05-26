'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

/**
 * Extends budget_targets with the two columns introduced in issue #201:
 *   - scope: 'personal' | 'partner' | 'business' | 'household'.
 *     Defaults to 'household' so legacy rows keep current behavior
 *     (which already summed across all shared/household spend).
 *   - rollover_enabled: store the toggle so the UI can persist user intent.
 *     The rollover *behavior* (carrying unused budget across periods) is
 *     out of scope for this PR — the flag is captured for the follow-up.
 *
 * Stored as STRING/BOOLEAN, not enum, so future scope values
 * (e.g. 'entity:<id>') don't require a destructive migration.
 */

async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

async function removeIndex(queryInterface, table, name) {
  try {
    await queryInterface.removeIndex(table, name);
  } catch (e) {
    if (!String(e && e.message).includes('does not exist')) throw e;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('budget_targets', 'scope', {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'household',
    });
    await queryInterface.addColumn('budget_targets', 'rollover_enabled', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await addIndex(
      queryInterface,
      'budget_targets',
      ['household_id', 'scope', 'currency', 'category'],
      { name: 'budget_targets_household_scope_currency_category' }
    );
  },

  async down(queryInterface) {
    await removeIndex(
      queryInterface,
      'budget_targets',
      'budget_targets_household_scope_currency_category'
    );
    await queryInterface.removeColumn('budget_targets', 'rollover_enabled');
    await queryInterface.removeColumn('budget_targets', 'scope');
  },
};
