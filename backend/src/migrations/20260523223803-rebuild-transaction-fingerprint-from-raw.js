'use strict';

const crypto = require('crypto');

// Mirrors rowFingerprint() in backend/src/import/fingerprint.ts. Key order
// here MUST match the order in the TS file — JSON.stringify is insertion-
// order dependent and the produced hash depends on it.
function computeFingerprint(row) {
  const data = {
    accountId: row.account_id,
    date: row.date,
    amount: String(parseFloat(row.amount)),
    currency: String(row.currency || '').toUpperCase(),
    merchantRaw: String(row.merchant_raw || ''),
    sourceReference: row.source_reference || null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

/**
 * source_row_fingerprint previously hashed merchant_clean, which is the
 * output of normalizeMerchant(). normalizeMerchant evolves over time, so
 * fingerprints stored from older imports cannot be reproduced from current
 * code — re-importing the same CSV after a normalize change inserts
 * duplicates because the new fingerprint does not collide with the old.
 *
 * This migration:
 *   1. Recomputes source_row_fingerprint for every transaction using
 *      merchant_raw (bank-provided, stable).
 *   2. Resolves any (account_id, new_fingerprint) collisions by keeping the
 *      oldest row (lowest id) and deleting the rest. Transactions with no
 *      collisions get their fingerprint rewritten.
 *
 * Down migration is intentionally unsupported: merchant_clean values are
 * derived from the current normalizeMerchant impl, not the impl that was
 * live when the original fingerprint was written, so we cannot reproduce
 * the old fingerprints.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.transaction(async (t) => {
      const [rows] = await sequelize.query(
        `SELECT id, account_id, date, amount, currency, merchant_raw, source_reference,
                category_override, business_override, split_override, reviewed_at
         FROM transactions
         ORDER BY id ASC`,
        { transaction: t }
      );

      // Group by (account_id, newFp). Within each group prefer rows with user
      // edits (category/business/split override, or reviewed_at); ties by
      // lowest id. Losers are deleted.
      const groups = new Map(); // key -> { winner: row, edited: boolean, losers: [id] }
      const fpById = new Map();
      const hasEdits = (r) =>
        r.category_override != null ||
        r.business_override != null ||
        r.split_override != null ||
        r.reviewed_at != null;

      for (const row of rows) {
        const fp = computeFingerprint(row);
        fpById.set(row.id, fp);
        const key = `${row.account_id}|${fp}`;
        const edited = hasEdits(row);
        const g = groups.get(key);
        if (g == null) {
          groups.set(key, { winner: row, edited, losers: [] });
          continue;
        }
        if (edited && !g.edited) {
          g.losers.push(g.winner.id);
          g.winner = row;
          g.edited = true;
        } else {
          g.losers.push(row.id);
        }
      }

      const deletions = [];
      const updates = [];
      for (const g of groups.values()) {
        updates.push({ id: g.winner.id, fp: fpById.get(g.winner.id) });
        deletions.push(...g.losers);
      }

      // Delete losing duplicates first. Dependent rows (transaction_signals,
      // ai_suggestions, receipts, transaction_order_links) cascade per the
      // initial schema FK definitions.
      const BATCH = 500;
      for (let i = 0; i < deletions.length; i += BATCH) {
        const chunk = deletions.slice(i, i + BATCH);
        await sequelize.query(
          `DELETE FROM transactions WHERE id IN (${chunk.map(() => '?').join(',')})`,
          { replacements: chunk, transaction: t }
        );
      }

      // Drop the unique index before rewriting fingerprints. A row's new_fp
      // could equal another row's old_fp (extremely unlikely but the unique
      // index would block it mid-loop). Recreate the index at the end —
      // failure there means the dedup logic above was wrong.
      await queryInterface.removeIndex('transactions', 'transactions_account_fingerprint_unique', {
        transaction: t,
      });

      for (const u of updates) {
        await sequelize.query(
          'UPDATE transactions SET source_row_fingerprint = ? WHERE id = ?',
          { replacements: [u.fp, u.id], transaction: t }
        );
      }

      await queryInterface.addIndex('transactions', ['account_id', 'source_row_fingerprint'], {
        unique: true,
        name: 'transactions_account_fingerprint_unique',
        transaction: t,
      });
    });
  },

  async down() {
    throw new Error(
      'Irreversible: cannot reconstruct historical merchant_clean values used by prior fingerprints'
    );
  },
};
