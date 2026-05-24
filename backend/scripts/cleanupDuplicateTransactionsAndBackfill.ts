#!/usr/bin/env tsx
/**
 * One-shot cleanup for the source-reference-instability dedup gap.
 *
 * Phase A: for every (account_id, date, amount, merchant_raw, currency) group with
 *   exactly 2 rows AND one NULL source_reference + one populated source_reference,
 *   copy the populated ref onto the older row, recompute its fingerprint using the
 *   new (merchantRaw-based) formula, and delete the newer row. Cascade-deletes
 *   transaction_signals/receipts/ai_suggestions/transaction_order_links via FK.
 *
 * Phase B: recompute source_row_fingerprint for every remaining transaction using
 *   the new formula. Skips rows whose stored fp already matches.
 *
 * Legit airline/Starbucks pairs (both populated, refs differ) are left untouched
 * because they don't match the Phase A predicate.
 *
 * Flags:
 *   --dry-run        report counts, write nothing
 *
 * Run against prod:
 *   PUB=$(railway variables --service backend --json | jq -r .DATABASE_PUBLIC_URL)
 *   DATABASE_URL="$PUB" yarn workspace cashflow-backend tsx \
 *     scripts/cleanupDuplicateTransactionsAndBackfill.ts --dry-run
 */
import { Op, type Transaction as SequelizeTransaction } from 'sequelize';
import { sequelize, Transaction } from '../src/models';
import { rowFingerprint } from '../src/import/fingerprint';

interface Args {
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  return { dryRun: argv.includes('--dry-run') };
}

interface PairRow {
  account_id: number;
  date: string;
  amount: string;
  currency: string;
  merchant_raw: string;
  older_id: number;
  older_source_ref: string | null;
  newer_id: number;
  newer_source_ref: string | null;
}

async function findNullPopulatedPairs(t: SequelizeTransaction): Promise<PairRow[]> {
  const sql = `
    WITH g AS (
      SELECT
        account_id, date, amount, currency, merchant_raw,
        array_agg(id ORDER BY id) AS ids,
        array_agg(source_reference ORDER BY id) AS refs
      FROM transactions
      GROUP BY account_id, date, amount, currency, merchant_raw
      HAVING COUNT(*) = 2
         AND COUNT(*) FILTER (WHERE source_reference IS NULL) = 1
         AND COUNT(*) FILTER (WHERE source_reference IS NOT NULL) = 1
    )
    SELECT account_id, date, amount, currency, merchant_raw,
           ids[1] AS older_id, refs[1] AS older_source_ref,
           ids[2] AS newer_id, refs[2] AS newer_source_ref
    FROM g
  `;
  const [rows] = await sequelize.query(sql, { transaction: t });
  return rows as PairRow[];
}

async function phaseA(args: Args): Promise<{ pairs: number; deleted: number; backfilled: number }> {
  let pairs = 0;
  let deleted = 0;
  let backfilled = 0;

  await sequelize.transaction(async (t) => {
    const found = await findNullPopulatedPairs(t);
    pairs = found.length;
    console.log(`[phase A] candidate pairs: ${pairs}`);

    for (const p of found) {
      const populated = p.older_source_ref ?? p.newer_source_ref;
      const olderHasNull = p.older_source_ref == null;
      const keepId = olderHasNull ? p.older_id : p.newer_id;
      const dropId = olderHasNull ? p.newer_id : p.older_id;

      if (populated == null) {
        throw new Error(`pair has no populated ref (acct=${p.account_id} date=${p.date} ids=[${p.older_id},${p.newer_id}])`);
      }

      const newFp = rowFingerprint({
        accountId: p.account_id,
        date: p.date,
        amount: Number(p.amount),
        currency: p.currency,
        merchantRaw: p.merchant_raw,
        sourceReference: populated,
      });

      console.log(
        `  keep=${keepId} drop=${dropId} acct=${p.account_id} ${p.date} ${p.amount} ` +
        `${p.merchant_raw.trim().slice(0, 40)} ref=${populated}`,
      );

      if (!args.dryRun) {
        // Delete the loser FIRST: it already has `newFp` stored (computed at
        // insert time under the new-merchantRaw formula deployed in prior PR),
        // so writing `newFp` onto the keeper would otherwise violate the
        // (account_id, source_row_fingerprint) unique index.
        const removed = await Transaction.destroy({
          where: { id: dropId },
          transaction: t,
        });
        deleted += removed;
        const [updated] = await Transaction.update(
          { sourceReference: populated, sourceRowFingerprint: newFp },
          { where: { id: keepId }, transaction: t },
        );
        backfilled += updated;
      }
    }
  });

  return { pairs, deleted, backfilled };
}

async function phaseB(args: Args): Promise<{ total: number; recomputed: number }> {
  let total = 0;
  let recomputed = 0;

  if (args.dryRun) {
    const all = await Transaction.count();
    console.log(`[phase B] would scan ${all} transactions to refresh fingerprints (dry run)`);
    return { total: all, recomputed: 0 };
  }

  const batchSize = 500;
  let offset = 0;
  // Loop in a single outer transaction so unique-index conflicts roll back cleanly.
  await sequelize.transaction(async (t) => {
    while (true) {
      const batch = await Transaction.findAll({
        order: [['id', 'ASC']],
        limit: batchSize,
        offset,
        transaction: t,
      });
      if (batch.length === 0) break;
      for (const row of batch) {
        total += 1;
        const newFp = rowFingerprint({
          accountId: row.accountId,
          date: row.date,
          amount: Number(row.amount),
          currency: row.currency,
          merchantRaw: row.merchantRaw,
          sourceReference: row.sourceReference ?? null,
        });
        if (newFp !== row.sourceRowFingerprint) {
          row.sourceRowFingerprint = newFp;
          await row.save({ transaction: t, hooks: false, silent: true, fields: ['sourceRowFingerprint'] });
          recomputed += 1;
        }
      }
      offset += batch.length;
      console.log(`[phase B] scanned ${offset} so far (recomputed=${recomputed})`);
    }
  });

  return { total, recomputed };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`mode: ${args.dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`db host: ${(process.env.DATABASE_URL || '').split('@')[1]?.split('/')[0] ?? 'unknown'}`);

  const a = await phaseA(args);
  const b = await phaseB(args);

  console.log('--- summary ---');
  console.log(`phase A pairs found:      ${a.pairs}`);
  console.log(`phase A rows deleted:     ${a.deleted}`);
  console.log(`phase A rows backfilled:  ${a.backfilled}`);
  console.log(`phase B rows scanned:     ${b.total}`);
  console.log(`phase B fingerprints upd: ${b.recomputed}`);

  await sequelize.close();
}

main().catch((e) => {
  console.error(e);
  void sequelize.close().finally(() => process.exit(1));
});
