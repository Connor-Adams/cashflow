'use strict';

/**
 * Budget breach proactive alert foundation (issue #268).
 *
 * Two schema changes that together let the daily `budget_breach_check` cron
 * (a) decide which thresholds to fire per budget and (b) record exactly which
 * (user, budget, period, threshold) tuples have already been alerted so a
 * subsequent tick in the same period is a no-op:
 *
 * 1. `budget_targets.alert_thresholds` — new JSON column storing the list of
 *    percentage thresholds the user wants to be alerted at for this budget.
 *    Defaults to `[80, 100, 120]` for legacy rows so existing budgets begin
 *    surfacing alerts without an explicit migration step on the user's side.
 *    The route layer validates the array (integers 1–500) and the cron
 *    iterates whatever values are present, so users can tune signal/noise per
 *    category later by editing this list. JSON (not a TEXT/CSV) keeps the
 *    column self-describing in psql and matches how `notifications.data_json`
 *    already stores structured payload context.
 *
 * 2. `budget_alert_states` — one row per (user, budget, period, threshold)
 *    that has already been alerted. Unique (user_id, budget_target_id,
 *    period_key, threshold) is the dedup key the cron tests *before* calling
 *    `enqueueNotification`. ON DELETE CASCADE from `budget_targets` cleans up
 *    orphans the moment a user deletes a budget mid-period (AC #12), avoiding
 *    a periodic cleanup job. `period_key` is a small string like '2026-05'
 *    for monthly, '2026-W21' for weekly, '2026' for annual — kept as a free
 *    string so the cron, not the DB, owns the period vocabulary.
 *
 * Reversible: down drops the new table and removes the new column. Existing
 * `budget_targets` rows survive intact.
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
    await queryInterface.addColumn('budget_targets', 'alert_thresholds', {
      type: Sequelize.JSON,
      allowNull: false,
      defaultValue: [80, 100, 120],
    });

    await queryInterface.createTable('budget_alert_states', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      budget_target_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'budget_targets', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      period_key: {
        type: Sequelize.STRING(16),
        allowNull: false,
      },
      threshold: {
        type: Sequelize.SMALLINT,
        allowNull: false,
      },
      alerted_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    // Dedup key the cron probes before enqueueing. Also covers the per-budget
    // cleanup scan ('rows for this budget id') because the index is composite
    // and budget_target_id is the second column.
    await addIndex(
      queryInterface,
      'budget_alert_states',
      ['user_id', 'budget_target_id', 'period_key', 'threshold'],
      {
        name: 'budget_alert_states_user_budget_period_threshold',
        unique: true,
      },
    );

    // Index by budget id powers the FK cascade and any future per-budget
    // queries (e.g. "what alerts has this budget fired this period?").
    await addIndex(queryInterface, 'budget_alert_states', ['budget_target_id'], {
      name: 'budget_alert_states_budget_target_id',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('budget_alert_states');
    await queryInterface.removeColumn('budget_targets', 'alert_thresholds');
  },
};
