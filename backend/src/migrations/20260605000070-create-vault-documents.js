'use strict';

/**
 * Encrypted finance vault (Cashflow issue #241).
 *
 * Stores arbitrary finance documents (receipts attached outside the
 * `receipts` table, statements, tax slips, invoices, warranties, contracts).
 * Mirrors the metadata shape of `receipts` but layered with optional
 * client-side AES-256-GCM encryption at rest and explicit linkage to many
 * different finance entity types.
 *
 * Why a NEW table instead of reusing `receipts`:
 *  - receipts.transaction_id is NOT NULL — vault docs are not always tied
 *    to a transaction (e.g. tax-year statements, contracts).
 *  - vault rows carry encryption metadata + free-form tags that don't
 *    apply to existing receipts.
 *  - keeping the tables separate means existing receipt routes/queries
 *    do not need to learn about vault visibility or encryption.
 *
 * Columns of note:
 *  - `household_id` NOT NULL + indexed: every list query scopes by household.
 *  - `uploaded_by_user_id` NULLABLE + ON DELETE SET NULL: dropping the user
 *    does NOT orphan-destroy the household's vault.
 *  - `visibility` matches the per-row visibility convention used by
 *    transactions/accounts ('shared' / 'private'), so the same auth scope
 *    helpers (visibleWhere) can filter the table.
 *  - `storage_kind` STRING(16) records whether the bytes are on disk
 *    locally or in S3 (parity with receiptStorage). Allows graceful
 *    deployment transitions without a destructive migration.
 *  - `encryption_algorithm` STRING(32) defaults to 'aes-256-gcm' but can
 *    be 'none' when the vault encryption key is not configured (local dev).
 *  - `encryption_key_version` SMALLINT defaults 1 to support future key
 *    rotation: new envelopes get version=2, decryption picks the key.
 *  - `tags` JSONB (Postgres) / JSON (SQLite) — an array of free-form tag
 *    strings. Filter via JSON containment in Postgres, fallback to LIKE
 *    on SQLite tests.
 *  - `linked_entity_type` + `linked_entity_id` give a soft cross-reference
 *    to any finance entity. We intentionally do NOT add a foreign-key
 *    constraint — the type column dispatches to the right table and the
 *    set of valid entity types is allowed to grow.
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
    await queryInterface.createTable('vault_documents', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      uploaded_by_user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      visibility: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'shared',
      },
      original_name: {
        type: Sequelize.STRING(512),
        allowNull: false,
      },
      mime_type: {
        type: Sequelize.STRING(128),
        allowNull: false,
      },
      size_bytes: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      stored_filename: {
        type: Sequelize.STRING(512),
        allowNull: false,
      },
      storage_kind: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'local',
      },
      encryption_algorithm: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'aes-256-gcm',
      },
      encryption_key_version: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      tags: {
        // Cross-dialect JSON: Sequelize maps JSON -> json on postgres and
        // TEXT on sqlite. Both round-trip array<string> via the model.
        type: Sequelize.JSON,
        allowNull: true,
      },
      linked_entity_type: {
        type: Sequelize.STRING(32),
        allowNull: true,
      },
      linked_entity_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(queryInterface, 'vault_documents', ['household_id'], {
      name: 'vault_documents_household_id',
    });
    await addIndex(
      queryInterface,
      'vault_documents',
      ['household_id', 'linked_entity_type', 'linked_entity_id'],
      { name: 'vault_documents_household_entity' },
    );
    await addIndex(
      queryInterface,
      'vault_documents',
      ['household_id', 'uploaded_by_user_id'],
      { name: 'vault_documents_household_uploader' },
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('vault_documents');
  },
};
