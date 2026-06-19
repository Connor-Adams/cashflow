'use strict';

/**
 * Cashflow #639 — finish the #402 demotion. Re-home money-leak dismissals onto
 * the Observation primitive (the `insights` table) and drop the standalone
 * `money_leak_dismissals` table.
 *
 * A dismissed MoneyLeak becomes an Insight row:
 *   - type        = leak_type            (one of the 5 detector outputs)
 *   - status      = 'dismissed'          (terminal state of the open→dismissed
 *                                          →resolved Observation lifecycle)
 *   - entity_type = 'money_leak'         (scopes the dismissal-as-Insight query)
 *   - entity_id   = NULL                 (leak identity is composite, not a PK)
 *   - fingerprint = `${leak_type}|${identity_key}`  (carries identity_key; the
 *       insights_household_type_fingerprint unique index mirrors the old
 *       money_leak_dismissals (household, leak_type, identity_key) unique)
 *   - metadata    = snapshot             (JSONB→JSON; round-trips both dialects)
 *   - user_id     = dismissed_by_user_id
 *   - title       = synthesized (insights.title is NOT NULL)
 *   - detected_at = created_at           (when the dismissal was first recorded)
 *
 * ZERO dismissal loss: every money_leak_dismissals row is copied before the
 * drop. Reversible: down() recreates the table + indexes (mirroring
 * 20260602100000-money-leak-dismissals.js) and copies the dismissed-leak
 * Insights back out, then deletes those Insight rows. The copy is JS
 * (raw SELECT + bulkInsert), not raw SQL, so Sequelize coerces dates on both
 * Postgres and SQLite, and JSON is normalized explicitly to preserve fidelity.
 */

const LEAK_TYPES = [
  'subscription_price_increase',
  'small_subscription',
  'recurring_fee',
  'duplicate_service',
  'delivery_fee_high',
];

const LEAK_ENTITY_TYPE = 'money_leak';

/**
 * Normalize a JSON column value (snapshot / metadata) to a JS object|null. The
 * raw SELECT returns a string on SQLite and an already-parsed object on
 * Postgres; normalize so bulkInsert writes consistent JSON on both dialects.
 */
function readJson(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  return value;
}

/**
 * Serialize a JS object|null for insertion into a JSON column. Postgres JSON
 * and SQLite TEXT both accept a JSON-text string; null stays null.
 */
function writeJson(value) {
  if (value == null) return null;
  return JSON.stringify(value);
}

async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // 1. Copy every dismissal into insights as a dismissed Observation.
    const [dismissals] = await queryInterface.sequelize.query(
      'SELECT * FROM money_leak_dismissals',
    );
    if (dismissals.length) {
      const rows = dismissals.map((d) => ({
        household_id: d.household_id,
        user_id: d.dismissed_by_user_id,
        type: d.leak_type,
        severity: 'info',
        title: `Dismissed money leak: ${d.leak_type}`,
        description: null,
        entity_type: LEAK_ENTITY_TYPE,
        entity_id: null,
        status: 'dismissed',
        fingerprint: `${d.leak_type}|${d.identity_key}`,
        metadata: writeJson(readJson(d.snapshot)),
        detected_at: d.created_at,
        created_at: d.created_at,
        updated_at: d.updated_at,
      }));
      await queryInterface.bulkInsert('insights', rows);
    }

    // 2. Drop the now-empty standalone table.
    await queryInterface.dropTable('money_leak_dismissals');
  },

  async down(queryInterface, Sequelize) {
    // 1. Recreate the table exactly as 20260602100000-money-leak-dismissals.js.
    await queryInterface.createTable('money_leak_dismissals', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: { type: Sequelize.INTEGER, allowNull: false },
      leak_type: { type: Sequelize.STRING(64), allowNull: false },
      identity_key: { type: Sequelize.STRING(255), allowNull: false },
      snapshot: { type: Sequelize.JSONB, allowNull: true },
      dismissed_by_user_id: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await addIndex(
      queryInterface,
      'money_leak_dismissals',
      ['household_id', 'leak_type', 'identity_key'],
      { name: 'money_leak_dismissals_household_type_key_unique', unique: true },
    );
    await addIndex(queryInterface, 'money_leak_dismissals', ['household_id'], {
      name: 'money_leak_dismissals_household_id',
    });

    // 2. Copy the dismissed-leak Observations back out of insights.
    const typeList = LEAK_TYPES.map((t) => `'${t}'`).join(', ');
    const [insights] = await queryInterface.sequelize.query(
      `SELECT * FROM insights
       WHERE entity_type = '${LEAK_ENTITY_TYPE}'
         AND status = 'dismissed'
         AND type IN (${typeList})`,
    );
    if (insights.length) {
      const rows = insights.map((i) => {
        const prefix = `${i.type}|`;
        const identityKey =
          typeof i.fingerprint === 'string' && i.fingerprint.startsWith(prefix)
            ? i.fingerprint.slice(prefix.length)
            : i.fingerprint;
        return {
          household_id: i.household_id,
          leak_type: i.type,
          identity_key: identityKey,
          snapshot: writeJson(readJson(i.metadata)),
          dismissed_by_user_id: i.user_id,
          created_at: i.created_at,
          updated_at: i.updated_at,
        };
      });
      await queryInterface.bulkInsert('money_leak_dismissals', rows);

      // 3. Remove the folded Observations so the rollback is clean — the
      //    dismissals now live back in their own table.
      await queryInterface.bulkDelete('insights', {
        entity_type: LEAK_ENTITY_TYPE,
        status: 'dismissed',
        type: { [Sequelize.Op.in]: LEAK_TYPES },
      });
    }
  },
};
