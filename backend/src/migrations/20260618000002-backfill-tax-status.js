'use strict';

/**
 * Backfill tax_status on existing INVESTMENT accounts from their name.
 *
 * Registered accounts (TFSA/FHSA/RRSP/RRIF/RDSP) sitting at the historical
 * 'n_a' default leak their sheltered in-account income/gains onto the personal
 * T1: buildPersonalFacts allowlists tax_status IN ('non_registered','n_a'), so
 * only a registered_* status excludes them. This sets the correct status for
 * every investment account by name. Corp investment accounts also get
 * 'non_registered' — harmless, buildCorpFacts ignores tax_status.
 *
 * Idempotent (guards on tax_status <> target). Cross-dialect (LOWER(name) LIKE).
 * Mirrors src/tax/services/inferTaxStatus.ts as frozen raw SQL — migrations
 * must not depend on mutable app code. Sequential UPDATEs = last matching
 * keyword wins (the helper uses first-match); equivalent for real single-keyword
 * names. down() is a no-op (cannot reconstruct prior 'n_a' defaults).
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const map = [
      ['%tfsa%', 'registered_tfsa'],
      ['%fhsa%', 'registered_fhsa'],
      ['%rrsp%', 'registered_rrsp'],
      ['%rrif%', 'registered_rrif'],
      ['%rdsp%', 'registered_rdsp'],
      ['%resp%', 'registered_resp'],
    ];
    for (const [like, status] of map) {
      await sequelize.query(
        `UPDATE accounts SET tax_status = :status
          WHERE account_type = 'investment' AND LOWER(name) LIKE :like AND tax_status <> :status`,
        { replacements: { status, like } },
      );
    }
    await sequelize.query(
      `UPDATE accounts SET tax_status = 'non_registered'
        WHERE account_type = 'investment'
          AND LOWER(name) NOT LIKE '%tfsa%' AND LOWER(name) NOT LIKE '%fhsa%'
          AND LOWER(name) NOT LIKE '%rrsp%' AND LOWER(name) NOT LIKE '%rrif%'
          AND LOWER(name) NOT LIKE '%rdsp%' AND LOWER(name) NOT LIKE '%resp%'
          AND tax_status <> 'non_registered'`,
    );
  },

  async down() {
    // No-op: cannot reconstruct which investment accounts were 'n_a' before.
  },
};
