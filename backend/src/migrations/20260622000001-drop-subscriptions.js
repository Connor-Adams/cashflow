'use strict';

/**
 * Expectation fold — finish (Cashflow #402). Drop the orphaned `subscriptions`
 * table. Its Sequelize model was already deleted and its data was copied into
 * `planned_events` (kind='subscription', source='recurring_detection') by
 * 20260611000002-expectation-absorb-data.js. Nothing reads or writes the table
 * any more — routes/subscriptions.ts operates entirely on the merged
 * PlannedEvent model.
 *
 * Reversible: down() recreates the table + indexes (mirroring
 * 20260530000002-subscriptions.js) and re-copies the rows back out of
 * planned_events, inverting the absorb-data status mapping. The copy is done in
 * JS (raw SELECT + bulkInsert), not raw SQL, so Sequelize coerces booleans and
 * dates correctly on both Postgres and SQLite.
 *
 * Note: planned_events no longer carries price_change_detected (dropped by
 * 20260614000001 — that signal now lives in an Insight). down() therefore
 * restores price_change_detected as false; the live value, if any, is derivable
 * from open subscription_price_increase Insights.
 */

/** Inverse of mapStatus() in 20260611000002-expectation-absorb-data.js. */
function legacyStatus(status, statusUncertain) {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'ignored') return 'ignored';
  if (status === 'planned') return statusUncertain ? 'unknown' : 'active';
  // posted/skipped or any future state have no legacy equivalent; treat as
  // active so the round-trip restores a valid row rather than dropping it.
  return 'active';
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.removeIndex('subscriptions', 'subscriptions_household_status');
    await queryInterface.removeIndex('subscriptions', 'subscriptions_household_name_currency_unique');
    await queryInterface.dropTable('subscriptions');
  },

  async down(queryInterface, Sequelize) {
    // 1. Recreate the table exactly as 20260530000002-subscriptions.js did.
    await queryInterface.createTable('subscriptions', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: { type: Sequelize.INTEGER, allowNull: false },
      merchant_name: { type: Sequelize.STRING(255), allowNull: false },
      normalized_name: { type: Sequelize.STRING(255), allowNull: false },
      amount: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      currency: { type: Sequelize.STRING(3), allowNull: false },
      cadence: { type: Sequelize.STRING(16), allowNull: false },
      last_charge_date: { type: Sequelize.DATEONLY, allowNull: false },
      next_expected_date: { type: Sequelize.DATEONLY, allowNull: true },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'active' },
      category: { type: Sequelize.STRING(128), allowNull: true },
      annualized_cost: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      price_change_detected: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      cancellation_url: { type: Sequelize.TEXT, allowNull: true },
      notes: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex(
      'subscriptions',
      ['household_id', 'normalized_name', 'currency'],
      { name: 'subscriptions_household_name_currency_unique', unique: true },
    );
    await queryInterface.addIndex(
      'subscriptions',
      ['household_id', 'status'],
      { name: 'subscriptions_household_status' },
    );

    // 2. Re-copy the folded subscription rows back out of planned_events.
    const [events] = await queryInterface.sequelize.query(
      "SELECT * FROM planned_events WHERE kind = 'subscription' AND source = 'recurring_detection'",
    );
    if (!events.length) return;

    const rows = events.map((e) => ({
      household_id: e.household_id,
      merchant_name: e.name,
      normalized_name: e.normalized_name,
      amount: e.amount,
      currency: e.currency,
      cadence: e.cadence,
      // last_charge_date is NOT NULL on subscriptions; fall back to the
      // expected_date the absorb-data migration derived from it.
      last_charge_date: e.last_charge_date || e.expected_date,
      next_expected_date: e.next_expected_date,
      status: legacyStatus(e.status, e.status_uncertain),
      category: e.category,
      // annualized_cost is NOT NULL on subscriptions; 0 is a safe restore floor.
      annualized_cost: e.annualized_cost == null ? '0' : e.annualized_cost,
      price_change_detected: false,
      cancellation_url: e.cancellation_url,
      notes: e.notes,
      created_at: e.created_at,
      updated_at: e.updated_at,
    }));
    await queryInterface.bulkInsert('subscriptions', rows);
  },
};
