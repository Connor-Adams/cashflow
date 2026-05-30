'use strict';

/**
 * CFO briefings (issue #236).
 *
 * Persists daily/weekly finance briefings: the deterministic action-item
 * list plus an optional safe-to-spend headline snapshot at generation
 * time. Distinct from `ai_review_runs` (#210) because:
 *   - Scope is daily/weekly (small windows) rather than monthly review.
 *   - Adds `safe_to_spend_snapshot` JSON for the headline number.
 *   - Item statuses are 'open' | 'resolved' | 'dismissed' (semantic
 *     difference from 'suggested' | 'accepted' | 'dismissed').
 *
 * Schema choices:
 * - `status` STRING(32) so we can move to async generation later without a
 *   destructive migration.
 * - `period_start`/`period_end` DATEONLY (YYYY-MM-DD).
 * - `action_items` and `safe_to_spend_snapshot` JSON columns — keep run
 *   atomic + self-contained.
 * - `model` / `prompt_version` mirror the AiReviewRun bookkeeping.
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
    await queryInterface.createTable('cfo_briefings', {
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
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      period_start: {
        type: Sequelize.DATEONLY,
        allowNull: false,
      },
      period_end: {
        type: Sequelize.DATEONLY,
        allowNull: false,
      },
      currency: {
        type: Sequelize.STRING(3),
        allowNull: false,
        defaultValue: 'CAD',
      },
      status: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'completed',
      },
      summary: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      action_items: {
        type: Sequelize.JSON,
        allowNull: false,
        defaultValue: [],
      },
      safe_to_spend_snapshot: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      model: {
        type: Sequelize.STRING(128),
        allowNull: true,
      },
      prompt_version: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      error_message: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(queryInterface, 'cfo_briefings', ['household_id'], {
      name: 'cfo_briefings_household_id',
    });
    await addIndex(queryInterface, 'cfo_briefings', ['user_id'], {
      name: 'cfo_briefings_user_id',
    });
    await addIndex(
      queryInterface,
      'cfo_briefings',
      ['household_id', 'period_start'],
      { name: 'cfo_briefings_household_period_start' }
    );
    await addIndex(
      queryInterface,
      'cfo_briefings',
      ['household_id', 'created_at'],
      { name: 'cfo_briefings_household_created_at' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('cfo_briefings');
  },
};
