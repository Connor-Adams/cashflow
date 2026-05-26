'use strict';

/**
 * AI finance review runs (issue #210).
 *
 * Persists periodic (user-triggered or scheduled) reviews of a date window
 * with computed action items. Each run's `summary` is a short
 * human-readable headline; `action_items` is a JSON array — items live with
 * the run for atomicity and so a run is a fully self-contained snapshot.
 *
 * Schema choices:
 * - `status` is STRING(32), values 'pending'|'completed'|'failed' so we can
 *   move to async generation later without a destructive migration.
 * - `period_start`/`period_end` are DATEONLY (YYYY-MM-DD) to match how the
 *   rest of the app stores dateless date windows (transactions.date,
 *   planned_events.expected_date).
 * - `action_items` is JSON. Each item carries its own status so accept/
 *   dismiss can be tracked per-item without joining.
 * - `currency` defaults to CAD to match the household primary; stored so a
 *   run is reproducible without re-querying the user's settings.
 * - `model` / `prompt_version` mirror the AiSuggestion bookkeeping so we
 *   can A/B prompts without losing eval history.
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
    await queryInterface.createTable('ai_review_runs', {
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

    await addIndex(queryInterface, 'ai_review_runs', ['household_id'], {
      name: 'ai_review_runs_household_id',
    });
    await addIndex(queryInterface, 'ai_review_runs', ['user_id'], {
      name: 'ai_review_runs_user_id',
    });
    await addIndex(
      queryInterface,
      'ai_review_runs',
      ['household_id', 'period_start'],
      { name: 'ai_review_runs_household_period_start' }
    );
    await addIndex(
      queryInterface,
      'ai_review_runs',
      ['household_id', 'created_at'],
      { name: 'ai_review_runs_household_created_at' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ai_review_runs');
  },
};
