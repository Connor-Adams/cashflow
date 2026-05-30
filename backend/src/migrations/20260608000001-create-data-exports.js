'use strict';

/**
 * Data export archive table (issue #302).
 *
 * Each row tracks one full-user data export ZIP job. The lifecycle is:
 *   queued → running → ready | failed
 *
 * `storage_key` is the relative file path under STORAGE_DIR/exports/
 * (or an object-storage key if a future STORAGE_DRIVER=s3 driver is wired in).
 * It is intentionally NULL until the job finishes successfully.
 *
 * `expires_at` is set to `ready_at + 7 days` when the job succeeds; the
 * nightly `dataExportCleanup` cron deletes the physical file and soft-marks
 * the row once `expires_at < NOW()`.
 *
 * Indexes:
 *   (user_id, requested_at DESC) — powers the "list my exports" query
 *   (expires_at)                 — powers the cleanup cron
 *
 * Cascade on user delete: removing the user account removes all their
 * export rows (and the files should be removed by the cleanup job first).
 */

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('data_exports', {
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      user_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      status: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'queued',
      },
      requested_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      ready_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      expires_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      storage_key: {
        type: Sequelize.STRING(256),
        allowNull: true,
      },
      byte_size: {
        type: Sequelize.BIGINT,
        allowNull: true,
      },
      error_message: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    // Powers "list my exports newest-first" query.
    await queryInterface.addIndex('data_exports', ['user_id', 'requested_at'], {
      name: 'data_exports_user_requested_at',
    });

    // Powers cleanup cron (WHERE expires_at < NOW()).
    await queryInterface.addIndex('data_exports', ['expires_at'], {
      name: 'data_exports_expires_at',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('data_exports', 'data_exports_expires_at');
    await queryInterface.removeIndex('data_exports', 'data_exports_user_requested_at');
    await queryInterface.dropTable('data_exports');
  },
};
