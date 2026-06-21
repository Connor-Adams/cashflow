'use strict';

/**
 * Expectation fold — Phase A1, M2. Copy subscriptions -> planned_events as
 * kind='subscription'. Done in JS (not raw SQL) so Sequelize coerces booleans
 * and dates correctly on both Postgres and SQLite. Run AFTER application code is
 * deployed to read/write subscriptions through the merged model. Reversible:
 * down() deletes the copied rows.
 */
function mapStatus(s) {
  if (s === 'cancelled') return { status: 'cancelled', uncertain: false };
  if (s === 'ignored') return { status: 'ignored', uncertain: false };
  if (s === 'unknown') return { status: 'planned', uncertain: true };
  return { status: 'planned', uncertain: false }; // active + fallback
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const [subs] = await queryInterface.sequelize.query('SELECT * FROM subscriptions');
    if (!subs.length) return;
    const [owners] = await queryInterface.sequelize.query(
      "SELECT household_id, user_id FROM household_members WHERE role = 'owner'",
    );
    const ownerByHousehold = new Map(owners.map((o) => [o.household_id, o.user_id]));

    const rows = subs.map((s) => {
      const ownerId = ownerByHousehold.get(s.household_id);
      if (ownerId == null) {
        throw new Error(`household ${s.household_id} has no owner member; cannot backfill user_id`);
      }
      const m = mapStatus(s.status);
      return {
        household_id: s.household_id,
        user_id: ownerId,
        kind: 'subscription',
        type: 'expense',
        source: 'recurring_detection',
        name: s.merchant_name,
        normalized_name: s.normalized_name,
        amount: s.amount,
        currency: s.currency,
        cadence: s.cadence,
        last_charge_date: s.last_charge_date,
        next_expected_date: s.next_expected_date,
        expected_date: s.next_expected_date || s.last_charge_date,
        status: m.status,
        status_uncertain: m.uncertain,
        category: s.category,
        annualized_cost: s.annualized_cost,
        price_change_detected: s.price_change_detected,
        cancellation_url: s.cancellation_url,
        notes: s.notes,
        created_at: s.created_at,
        updated_at: s.updated_at,
      };
    });
    await queryInterface.bulkInsert('planned_events', rows);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('planned_events', {
      kind: 'subscription',
      source: 'recurring_detection',
    });
  },
};
