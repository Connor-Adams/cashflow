'use strict';

/**
 * Re-keys historical `transactions.merchant_clean` with the boilerplate-aware
 * normalizer added in the same PR (`backend/src/import/normalizeMerchant.ts`),
 * and prunes the recomputable `merchant_embeddings` cache of keys that no
 * longer exist.
 *
 * WHY THIS MIGRATION EXISTS (it is not cosmetic):
 * `merchant_clean` is the key merchant memory (`findMerchantMemory`) and Rule
 * patterns hinge on. Memory is a derived view — a `GROUP BY merchant_clean`
 * over reviewed transactions — so a *code-only* normalization change orphans
 * every existing bucket: memory keyed on
 * `DISCORD* NITROMONTHLY SAN FRANCISCO [UNITED STATES DOLLAR 11.29 @ 1.4349]`
 * becomes unreachable the moment a new import produces
 * `DISCORD* NITROMONTHLY SAN FRANCISCO`, and the new key starts at zero
 * support. Categorisation would get *worse* before it got better. Re-keying the
 * history is what carries the support counts across.
 *
 * MERGE SEMANTICS. Because memory is derived, re-keying merges buckets and
 * their support counts for free: N rows that held N distinct keys (support
 * 1 each) now share one key (support N). Crucially this migration rewrites only
 * `merchant_clean`. No row's `final_category` / `final_business` /
 * `final_split_type` / split percentages are touched, so when two merging
 * buckets DISAGREE on the categorisation, both labels survive on their own
 * rows and the disagreement stays visible (the Wealthsimple transfer sentences
 * are labelled `Transfer` some months and `Investments` others). The winner is
 * then resolved at read time by `findMerchantMemory`, deterministically:
 * highest support count, then most recent `reviewed_at`, then category name —
 * never by insertion order.
 *
 * WHAT IT DOES *NOT* DO:
 *   - It does not recompute `merchant_canonical`. That is a brand lookup owned
 *     by the enrichment normalize stage; a stale canonical is no worse than
 *     before, and `runEnrichmentBackfill` re-derives it.
 *   - It does not rewrite `merchant_raw`, which stays the untouched source of
 *     truth (and is what `detectTypeStage` reads alongside `merchant_clean`).
 *   - It does not touch Rules. Measured against production: of 59 rule
 *     patterns, zero rows lose a match and zero gain one.
 *
 * It runs the FULL normalizer, not just the new boilerplate strips. Applying
 * only the strips leaves rows whose value differs from what the import pipeline
 * produces — stripping `CONTACTLESS INTERAC PURCHASE - 9444 ` off
 * `SQ *HIGHLAND PI` exposes a processor prefix the later passes then remove, and
 * stripping an FX suffix exposes a trailing store number — and those rows would
 * be freshly orphaned by the next import. Measured on production: 23 such rows.
 */

// The normalizer is SHARED, not copied: `backend/lib/merchantNormalization.js`
// is plain CommonJS precisely so `sequelize-cli` (which loads migrations as
// plain JS, with no TypeScript pipeline) and the app's typed facade at
// `src/import/normalizeMerchant.ts` can run the identical function. Inlining a
// ~120-line copy here would drift silently from the live rules.
//
// The consequence, stated plainly: this migration is not frozen in time. Its
// contract is "make stored merchant_clean equal what the current normalizer
// produces", so re-running it after a later normalizer change re-converges
// rather than replaying 2026-09-28 semantics. That is the right contract for a
// derived, fully recomputable column -- `runEnrichmentBackfill` re-derives the
// same value from the untouched `merchant_raw` -- and it is why `up` is
// idempotent.
const { normalizeMerchant } = require('../../lib/merchantNormalization');

/**
 * The rows whose stored key the current normalizer disagrees with. A
 * normalization that produced nothing is a bug, not an improvement — an empty
 * `merchant_clean` is a row with no memory key and no rule surface — so those
 * rows are left alone.
 */
function plannedRekeys(rows) {
  const planned = [];
  for (const row of rows) {
    const next = normalizeMerchant(row.merchant_clean);
    if (next && next !== row.merchant_clean) planned.push({ id: row.id, merchantClean: next });
  }
  return planned;
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const [rows] = await queryInterface.sequelize.query(
        `SELECT id, merchant_clean FROM transactions
          WHERE merchant_clean IS NOT NULL AND merchant_clean != ''
          ORDER BY id ASC`,
        { transaction },
      );

      // One UPDATE per row: the values are arbitrary text and the row count is
      // in the low thousands (831 on production), so a CASE-folded bulk
      // statement buys nothing and costs readability.
      for (const rekey of plannedRekeys(rows)) {
        await queryInterface.sequelize.query(
          'UPDATE transactions SET merchant_clean = :mc WHERE id = :id',
          { replacements: { mc: rekey.merchantClean, id: rekey.id }, transaction },
        );
      }

      // merchant_embeddings is a pure memoization cache keyed on
      // merchant_clean (one vector per distinct key per model) and is fully
      // recomputable. Re-keying invalidates any entry whose key no longer
      // appears on a transaction, so drop those rather than leave vectors
      // nothing can ever hit again.
      await queryInterface.sequelize.query(
        `DELETE FROM merchant_embeddings
          WHERE merchant_clean NOT IN (
            SELECT merchant_clean FROM transactions
             WHERE merchant_clean IS NOT NULL AND merchant_clean != ''
          )`,
        { transaction },
      );
    });
  },

  async down() {
    // No-op, deliberately. The pre-migration values were boilerplate-laden
    // keys — an FX rate, an execution date or a terminal reference number per
    // transaction — and they are not recoverable from the schema: the
    // re-keying is many-to-one, so there is no way to tell which of the
    // thirteen `BT*IRACING ... [USD 1.35 @ <rate>]` spellings a given row had.
    // Restoring them would also re-fragment every merchant-memory bucket this
    // migration merged, which is the exact harm it exists to prevent.
    //
    // To genuinely revert: check out the prior `normalizeMerchant` and run
    // `runEnrichmentBackfill`, which re-derives merchant_clean from the
    // untouched `merchant_raw`.
  },
};
