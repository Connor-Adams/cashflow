'use strict';

/**
 * Idempotent, case-insensitive reconciliation of Wealthsimple corporate
 * accounts to their household's corp Entity.
 *
 * SUPERSEDES 20260601000001-link-ws-corp-accounts-cdg.js, which no-ops in prod
 * for two reasons: (a) it ran before the corp Entity existed (the Wise/RBC
 * importer auto-creates the corp 'CDG LABS INC.' on first upload), and (b) it
 * matched legal_name = 'CDG Labs Inc.' while the importer actually stores
 * 'CDG LABS INC.' (case mismatch). Because that migration is already recorded
 * in SequelizeMeta, it cannot re-run; this NEW migration fixes the gap and is
 * safe to re-run on every deploy.
 *
 * Strategy (no hardcoded account ids): for every household that HAS a corp
 * Entity, point its Wealthsimple-corp-named accounts (Corporate Investing /
 * Corporate Chequing / Save for Business) at that corp Entity when they are
 * not already linked to it. Matching is by account NAME pattern + per-household
 * corp entity — self-healing and environment-independent.
 *
 * No-op when a household has no corp Entity. Down: intentional no-op (unlinking
 * would reintroduce the bad personal mapping).
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const [corps] = await sequelize.query(
      `SELECT id, household_id FROM tax_entities WHERE kind = 'corp'`,
    );
    for (const corp of corps) {
      await sequelize.query(
        `UPDATE accounts
            SET entity_id = :corpId
          WHERE household_id = :hid
            AND (entity_id IS NULL OR entity_id <> :corpId)
            AND (
              lower(name) LIKE '%corporate investing%'
              OR lower(name) LIKE '%corporate chequing%'
              OR lower(name) LIKE '%save for business%'
            )`,
        { replacements: { corpId: corp.id, hid: corp.household_id } },
      );
    }
  },

  async down() {
    // intentional no-op — see header comment
  },
};
