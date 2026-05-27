'use strict';

/**
 * Notification system foundation (issue #266).
 *
 * Two tables that together let any feature surface an event to a user via an
 * in-app inbox, while letting the user choose per-event-type whether the
 * delivery happens at all and which channels are enabled:
 *
 * 1. `notifications` — one row per delivered in-app notification. The
 *    `enqueueNotification()` server helper writes here ONLY when the user's
 *    preference for the `type` has `channel_in_app=true`. Severity is a
 *    string ENUM rather than a DB-enum so adding a new severity later
 *    doesn't require a migration on every dialect (sqlite vs postgres
 *    handle enums differently). `data_json` is intentionally a JSON column
 *    (Postgres JSONB, sqlite TEXT/JSON) so downstream features can attach
 *    structured payload context without a schema change per feature.
 *    Index `(user_id, read_at, created_at DESC)` powers the bell query
 *    "unread first, then newest-first" without scanning every row.
 *
 * 2. `notification_preferences` — at most one row per (user_id, type). A
 *    missing row implicitly means the default `(in_app=true, email=false)`;
 *    the route layer returns defaults for unknown types and the
 *    `enqueueNotification()` helper treats "no row" as "deliver in-app".
 *    Email channel is recorded here for forward compatibility, but this
 *    issue does NOT send any email — that's deferred to the channel-specific
 *    follow-up issues (weekly digest, budget breach alert).
 *
 * Both tables cascade on user deletion; we never want orphaned notification
 * rows around.
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
    await queryInterface.createTable('notifications', {
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
      type: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      severity: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'info',
      },
      title: {
        type: Sequelize.STRING(160),
        allowNull: false,
      },
      body: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      data_json: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      read_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    // Composite index powers the bell query (unread first, newest-first) and
    // also covers /unread-count without a separate index.
    await addIndex(
      queryInterface,
      'notifications',
      ['user_id', 'read_at', 'created_at'],
      { name: 'notifications_user_read_created' },
    );

    await queryInterface.createTable('notification_preferences', {
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
      type: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      channel_in_app: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      channel_email: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    // Upsert key: one preference row per (user, type).
    await addIndex(
      queryInterface,
      'notification_preferences',
      ['user_id', 'type'],
      {
        name: 'notification_preferences_user_type',
        unique: true,
      },
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('notification_preferences');
    await queryInterface.dropTable('notifications');
  },
};
