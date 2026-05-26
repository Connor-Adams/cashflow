'use strict';

/**
 * Tax reserve settings table (issue #223).
 *
 * Per-household, per-currency knob driving the tax reserve calculator:
 * - household_id + currency together are the natural key (UNIQUE).
 * - reserve_percent: DECIMAL(7,4) — fraction in [0, 1]. e.g. 0.25 for "set
 *   aside 25% of net business income". DECIMAL keeps precision through the
 *   transport layer (everything else in the codebase uses string DECIMAL
 *   for money/percent — lossless).
 * - note: optional free-text describing the rule (e.g. "Federal + provincial
 *   estimate for sole prop in ON"). Surfaced in the UI alongside the value
 *   to satisfy AC #5 ("Calculation is clearly explained in the UI").
 *
 * Rows are created lazily on the first PUT — the GET endpoint synthesises
 * a default for any currency observed in the household's transactions if
 * no row exists yet. This matches the lazy pattern used by
 * cashflow_settings (issue #199 in a sibling branch).
 */

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('tax_reserve_settings', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      currency: {
        type: Sequelize.STRING(3),
        allowNull: false,
      },
      reserve_percent: {
        type: Sequelize.DECIMAL(7, 4),
        allowNull: false,
        defaultValue: '0.2500',
      },
      note: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(
      queryInterface,
      'tax_reserve_settings',
      ['household_id', 'currency'],
      {
        name: 'tax_reserve_settings_household_id_currency',
        unique: true,
      },
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('tax_reserve_settings');
  },
};
