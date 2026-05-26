'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

/**
 * money_leak_dismissals: stores per-household dismissals for the money
 * leaks dashboard (Cashflow #220).
 *
 * Leak rows themselves are deterministic — they are recomputed on every
 * read from subscriptions + transactions. The ONLY thing we need to
 * persist is "the user has acknowledged this leak and does not want to
 * see it again." We key dismissals on `(leakType, identityKey)`:
 *
 *   leakType     — one of the detector outputs (subscription_price_increase,
 *                  small_subscription, recurring_fee, duplicate_service,
 *                  delivery_fee_high). Stored as STRING so adding leak
 *                  types later does not require an ALTER TYPE migration.
 *   identityKey  — detector-supplied stable key. Each detector emits a
 *                  string that uniquely identifies the leak instance
 *                  within its type (e.g. "<subscriptionId>" for
 *                  subscription-derived leaks, "<currency>:<category>"
 *                  for duplicate-service clusters). Keys are stable across
 *                  refreshes so a dismissal sticks.
 *
 * The unique index on (household_id, leak_type, identity_key) keeps
 * dismissals idempotent — POSTing the same dismissal twice is a no-op.
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
    await queryInterface.createTable('money_leak_dismissals', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      leak_type: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      identity_key: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      // Snapshot of the dismissed leak for audit/undo purposes. Free-form
      // JSON so detectors can evolve their payload without a migration.
      snapshot: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      dismissed_by_user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(
      queryInterface,
      'money_leak_dismissals',
      ['household_id', 'leak_type', 'identity_key'],
      {
        name: 'money_leak_dismissals_household_type_key_unique',
        unique: true,
      },
    );
    await addIndex(
      queryInterface,
      'money_leak_dismissals',
      ['household_id'],
      { name: 'money_leak_dismissals_household_id' },
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('money_leak_dismissals');
  },
};
