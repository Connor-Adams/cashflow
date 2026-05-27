'use strict';

/**
 * Purchase intelligence (issue #218). Date suffix 000002 keeps this
 * migration ordered after the same-day migrations that landed in main
 * (20260603000001-transaction-transfer-purpose,
 *  20260603000001-transactions-import-confidence).
 *
 * Per-transaction sidecar table that promotes a transaction into a tracked
 * "purchase" with lifecycle metadata: receipt status, warranty info, useful
 * life, business relevance, and notes. 1:1 with transactions via
 * transaction_id as PRIMARY KEY.
 *
 * Kept off the hot transactions table because most rows never become tracked
 * purchases. Storing nullable lifecycle columns on transactions would bloat
 * the working set for queries that don't care about purchase intelligence.
 *
 * Schema choices:
 * - `transaction_id` is PK + FK with ON DELETE CASCADE so deleting a
 *   transaction cleans up its purchase profile.
 * - `household_id` is denormalised (NOT NULL) so list queries can scope
 *   without joining transactions for every row.
 * - `marked_by_user_id` is nullable + ON DELETE SET NULL so deleting a user
 *   doesn't orphan the household's tracked purchase records.
 * - `receipt_status` and `warranty_status` are STRING(16) so the value set
 *   can grow without a destructive migration.
 * - `warranty_expires_at` is DATEONLY (calendar date, no clock).
 * - `useful_life_months` is INTEGER nullable; cost-per-month-owned uses
 *   elapsed months when this is null, useful_life_months as the denominator
 *   when set (capped at elapsed once exceeded — see costPerMonth helper).
 * - Indexes target the common access patterns: list by household, filter by
 *   business_relevant, filter by receipt_status.
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
    await queryInterface.createTable('purchases', {
      transaction_id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        allowNull: false,
        references: { model: 'transactions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      marked_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      marked_by_user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      receipt_status: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'unknown',
      },
      warranty_status: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'unknown',
      },
      warranty_expires_at: {
        type: Sequelize.DATEONLY,
        allowNull: true,
      },
      warranty_provider: {
        type: Sequelize.STRING(256),
        allowNull: true,
      },
      business_relevant: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      useful_life_months: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(queryInterface, 'purchases', ['household_id'], {
      name: 'purchases_household_id',
    });
    await addIndex(queryInterface, 'purchases', ['business_relevant'], {
      name: 'purchases_business_relevant',
    });
    await addIndex(queryInterface, 'purchases', ['receipt_status'], {
      name: 'purchases_receipt_status',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('purchases');
  },
};
