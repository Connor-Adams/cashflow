'use strict';

/**
 * Idempotent backfill: link the two existing Wealthsimple corp accounts to the
 * CDG Labs Inc. corp Entity if it exists.
 *
 * Background: pre-existing prod state at the time the Wise importer landed —
 *   accounts.id=13 "Wealthsimple Corporate Investing" → entity_id=1 (Personal, WRONG)
 *   accounts.id=24 "Wealthsimple Corporate Chequing"  → entity_id=null
 *
 * The Wise importer auto-creates a `kind='corp'` Entity with `legal_name=
 * 'CDG Labs Inc.'` on first upload. This migration reconciles the WS corp
 * accounts to that same Entity so corp tagging is consistent across all
 * corporate accounts (Wise + Wealthsimple) in the household.
 *
 * Safe to run multiple times: noops if the corp Entity doesn't exist yet, or
 * if the accounts are already pointing at it. Skips quietly when the row IDs
 * don't exist (other environments).
 *
 * Down: noop — unlinking would reintroduce the bad mapping (id=13 → Personal).
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const [entities] = await queryInterface.sequelize.query(
      `SELECT id FROM tax_entities
        WHERE kind = 'corp'
          AND legal_name = 'CDG Labs Inc.'
        LIMIT 1`,
    );
    const corpEntityId = entities[0]?.id;
    if (!corpEntityId) return;

    await queryInterface.sequelize.query(
      `UPDATE accounts
          SET entity_id = :entityId
        WHERE id IN (13, 24)
          AND (entity_id IS NULL OR entity_id <> :entityId)`,
      { replacements: { entityId: corpEntityId } },
    );
  },

  async down() {
    // intentional noop — see header comment
  },
};
