'use strict';

/**
 * sync_backups — audit trail for encrypted backup bundles (Cashflow #239).
 *
 * One row per backup created. The bundle bytes themselves are NEVER stored
 * server-side — they're streamed to the user as a download. We retain
 * only the metadata: which user/household, when, what version of the
 * bundle codec, and per-table row counts (so support can verify a user's
 * claim about what was in a bundle they exported).
 *
 * No FK to households on purpose: keeping the row around after a
 * household is deleted is useful diagnostic context. household_id is
 * still indexed for per-household listing.
 */

async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('sync_backups', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      user_id: {
        // The user who triggered the backup. Nullable for system-driven
        // backups in the future (e.g. cloud sync agent).
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      kind: {
        // 'backup' for an export, 'restore' for an import. Same table
        // doubles as a restore audit so the timeline reads as one
        // contiguous history.
        type: Sequelize.STRING(16),
        allowNull: false,
      },
      bundle_version: {
        // The envelope-format version byte that was active when this
        // bundle was created/restored. Useful for forensic recovery
        // when we eventually rotate the format.
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      schema_version: {
        // The payload schemaVersion (table set / row shape).
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      bundle_bytes: {
        // Wire size of the base64-encoded bundle (not the decoded byte
        // length — what the user actually downloaded/uploaded).
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      table_counts: {
        // JSON map of table_name -> row count. Use JSONB on Postgres,
        // TEXT on SQLite — JSON type lets Sequelize handle both.
        type: Sequelize.JSON,
        allowNull: false,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(queryInterface, 'sync_backups', ['household_id', 'created_at'], {
      name: 'sync_backups_household_created_at',
    });
    await addIndex(queryInterface, 'sync_backups', ['household_id', 'kind'], {
      name: 'sync_backups_household_kind',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('sync_backups');
  },
};
