'use strict';

/**
 * Async PDF-bundle import tracking (infra, not a domain primitive — same
 * category as job_runs). A batch is one upload; an item is one PDF, parsed
 * + committed by the pdfImportProcess cron drain. Bytes live in vault storage
 * (S3/disk), referenced by stored_filename.
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
    await queryInterface.createTable('pdf_import_batches', {
      id: { type: Sequelize.UUID, primaryKey: true },
      household_id: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: 'households', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      user_id: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: 'users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'pending' },
      total: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      processed: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      succeeded: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      failed: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.createTable('pdf_import_items', {
      id: { type: Sequelize.UUID, primaryKey: true },
      batch_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'pdf_import_batches', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      file_name: { type: Sequelize.STRING(512), allowNull: false },
      stored_filename: { type: Sequelize.STRING(255), allowNull: false },
      storage_kind: { type: Sequelize.STRING(16), allowNull: false },
      encryption_algorithm: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'none' },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'pending' },
      account_id: {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: 'accounts', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      result_json: { type: Sequelize.JSON, allowNull: true },
      error: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await addIndex(queryInterface, 'pdf_import_batches', ['household_id'], { name: 'pdf_import_batches_household_id' });
    await addIndex(queryInterface, 'pdf_import_items', ['batch_id'], { name: 'pdf_import_items_batch_id' });
    await addIndex(queryInterface, 'pdf_import_items', ['status'], { name: 'pdf_import_items_status' });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('pdf_import_items');
    await queryInterface.dropTable('pdf_import_batches');
  },
};
