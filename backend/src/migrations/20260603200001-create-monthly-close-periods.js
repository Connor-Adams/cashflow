'use strict';

/**
 * Monthly close workflow (issue #227).
 *
 * Two tables back the month-end checklist:
 *
 * - `monthly_close_periods` — one row per (household, period_month). The
 *   `period_month` column is a TEXT 'YYYY-MM' string rather than a DATE
 *   so we can query/group on it as an exact string without timezone
 *   arithmetic. `status` is 'open' | 'closed' stored as STRING(16); the
 *   route layer validates. `closed_at` and `opened_at` are timestamps
 *   recording the actual close/reopen times so historical views can show
 *   when work happened, not just when the row was created.
 *
 * - `monthly_close_tasks` — N rows per period, one per checklist item.
 *   `task_key` is a short STRING(64) identifying the checklist slot
 *   (e.g. 'imports', 'review_inbox', 'settlements', 'taxes', etc.). The
 *   default tasks are seeded at period-start by the route layer; storing
 *   them as rows (instead of a JSON blob) lets us index by completion
 *   state and add per-task notes/audit trail later.
 *
 * The (household_id, period_month) UNIQUE index is the integrity backbone:
 * a household has exactly one period row per month. (period_id, task_key)
 * UNIQUE keeps a period from spawning duplicate task rows on retries.
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
    await queryInterface.createTable('monthly_close_periods', {
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
      period_month: {
        type: Sequelize.STRING(7),
        allowNull: false,
      },
      status: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'open',
      },
      opened_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      closed_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(queryInterface, 'monthly_close_periods', ['household_id'], {
      name: 'monthly_close_periods_household_id',
    });
    await addIndex(
      queryInterface,
      'monthly_close_periods',
      ['household_id', 'period_month'],
      {
        name: 'monthly_close_periods_household_period',
        unique: true,
      },
    );
    await addIndex(
      queryInterface,
      'monthly_close_periods',
      ['household_id', 'status'],
      {
        name: 'monthly_close_periods_household_status',
      },
    );

    await queryInterface.createTable('monthly_close_tasks', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      period_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'monthly_close_periods', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      task_key: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      is_complete: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      completed_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      completed_by_user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      sort_order: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(queryInterface, 'monthly_close_tasks', ['period_id'], {
      name: 'monthly_close_tasks_period_id',
    });
    await addIndex(
      queryInterface,
      'monthly_close_tasks',
      ['period_id', 'task_key'],
      {
        name: 'monthly_close_tasks_period_task_key',
        unique: true,
      },
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('monthly_close_tasks');
    await queryInterface.dropTable('monthly_close_periods');
  },
};
