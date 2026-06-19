'use strict';

/**
 * Web-push delivery foundation (issue #651).
 *
 * 1. `push_subscriptions` — one row per browser push endpoint a user has
 *    granted. `endpoint` is globally unique (per-browser URL from the push
 *    service) so a re-subscribe upserts instead of duplicating. `(p256dh,
 *    auth)` are the encryption secrets from the browser PushSubscription.
 *    Cascades on user deletion. `(user_id)` index powers the per-user
 *    fan-out at dispatch time.
 *
 * 2. `notification_preferences.channel_push` — new opt-in channel, default
 *    `false`, matching the existing `channel_in_app` / `channel_email`
 *    pattern. Existing rows backfill to `false` via the column default, so
 *    push is strictly opt-in.
 *
 * Dialect-portable: only `createTable` / `addColumn` / `addIndex` so it runs
 * identically on SQLite (unit/dev) and Postgres (integration/prod).
 */

/** @param {import('sequelize').QueryInterface} queryInterface */
async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('push_subscriptions', {
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
      endpoint: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      p256dh: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      auth: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      user_agent: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    // One row per browser endpoint — idempotent re-subscribe upserts here.
    await addIndex(queryInterface, 'push_subscriptions', ['endpoint'], {
      name: 'push_subscriptions_endpoint_unique',
      unique: true,
    });

    // Per-user fan-out at dispatch time.
    await addIndex(queryInterface, 'push_subscriptions', ['user_id'], {
      name: 'push_subscriptions_user',
    });

    // New opt-in push channel. Default false so existing rows (and the
    // missing-row default) keep push OFF until the user enables it.
    await queryInterface.addColumn(
      'notification_preferences',
      'channel_push',
      {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('notification_preferences', 'channel_push');
    await queryInterface.dropTable('push_subscriptions');
  },
};
