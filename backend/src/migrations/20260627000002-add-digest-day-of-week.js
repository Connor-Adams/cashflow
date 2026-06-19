'use strict';

/**
 * Weekly-digest day-of-week preference (issue #796).
 *
 * Adds `notification_preferences.digest_day_of_week` — the weekday a user wants
 * their `digest.weekly` notification to land. SMALLINT 0..6 (0=Sun … 6=Sat),
 * default 1 (Monday) so existing preference rows keep the historical
 * Monday-anchored cadence with no backfill beyond the column default.
 *
 * `channel_push` is NOT added here — it already exists from the #651
 * push-subscriptions migration (20260619120000), which is the channel this
 * issue reuses.
 *
 * Dialect-portable: a single `addColumn` so it runs identically on SQLite
 * (unit/dev) and Postgres (integration/prod).
 */
module.exports = {
  /** @param {import('sequelize').QueryInterface} queryInterface */
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(
      'notification_preferences',
      'digest_day_of_week',
      {
        type: Sequelize.SMALLINT,
        allowNull: false,
        defaultValue: 1,
      },
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn(
      'notification_preferences',
      'digest_day_of_week',
    );
  },
};
