#!/usr/bin/env tsx
/**
 * Diagnostic + cleanup for the historical Amazon-matcher many-to-one fan-out.
 *
 * The old runAmazonMatching fallback (`confidence === best`) linked a single
 * transaction to EVERY Amazon order tied at the best sub-threshold score, so a
 * charge whose amount collided with many stale orders got an `accepted` link to
 * each (confidence 50/15, null linked_amount). This script finds those spurious
 * links — `accepted`, confidence < MATCH_CONFIDENCE_THRESHOLD, on a transaction
 * that has >= 2 accepted links — and demotes them to `rejected`.
 *
 * Confident links (>= threshold) and lone (1:1) sub-threshold links are NOT
 * touched; the latter are reported for visibility. Demoting to `rejected`
 * (rather than deleting) is reversible and keeps the audit trail; a user can
 * still re-link manually via POST /api/amazon/links/manual.
 *
 * Usage:
 *   cd backend && DATABASE_URL=... npx tsx scripts/cleanup-amazon-fanout-links.ts          # dry-run (read-only)
 *   cd backend && DATABASE_URL=... npx tsx scripts/cleanup-amazon-fanout-links.ts --commit # write
 *
 * Prod Postgres only (per project convention). Without DATABASE_URL this hits
 * local sqlite — the script refuses to --commit there.
 */
import { Op } from 'sequelize';
import { TransactionOrderLink, sequelize } from '../src/models';
import { planFanoutCleanup, type AcceptedLinkRow } from '../src/amazon/fanoutCleanup';
import { MATCH_CONFIDENCE_THRESHOLD } from '../src/amazon/matcher';
import { databaseUrl } from '../src/config/env';

const COMMIT = process.argv.includes('--commit');

async function main() {
  if (databaseUrl) {
    console.log(`Target DB: postgres (${new URL(databaseUrl).host})`);
  } else {
    console.log('Target DB: LOCAL SQLITE');
    if (COMMIT) {
      console.error('Refusing to --commit against local sqlite. Set DATABASE_URL to the prod Postgres URL.');
      process.exit(1);
    }
  }

  const accepted = await TransactionOrderLink.findAll({
    where: { status: 'accepted' },
    attributes: ['id', 'transactionId', 'confidence', 'status'],
    order: [['id', 'ASC']],
  });
  const rows: AcceptedLinkRow[] = accepted.map((link) => ({
    id: link.id,
    transactionId: link.transactionId,
    confidence: link.confidence,
    status: link.status,
  }));

  const plan = planFanoutCleanup(rows);

  console.log(
    `\n${accepted.length} accepted link(s) total.  Threshold = ${MATCH_CONFIDENCE_THRESHOLD}.` +
      `${COMMIT ? '' : '  [dry-run — pass --commit to write]'}`,
  );
  console.log(
    `Many-to-one fan-out clusters: ${plan.manyToOneClusters.length}` +
      `  →  ${plan.rejectIds.length} sub-threshold link(s) across ${plan.affectedTransactionIds.length} transaction(s) to reject.`,
  );
  for (const cluster of plan.manyToOneClusters) {
    console.log(
      `  txn ${cluster.transactionId}: ${cluster.total} accepted` +
        `  →  reject ${cluster.subThreshold}, keep ${cluster.keptStrong} (>= ${MATCH_CONFIDENCE_THRESHOLD})`,
    );
  }
  console.log(
    `\nLone (1:1) sub-threshold accepted link(s): ${plan.loneSubThreshold}  ` +
      `(out of scope — not touched)`,
  );

  if (!COMMIT) {
    console.log('\nDry-run only. No rows changed.');
    await sequelize.close();
    return;
  }

  if (plan.rejectIds.length === 0) {
    console.log('\nNothing to reject.');
    await sequelize.close();
    return;
  }

  const [updated] = await TransactionOrderLink.update(
    { status: 'rejected' },
    { where: { id: { [Op.in]: plan.rejectIds }, status: 'accepted' } },
  );
  console.log(`\nDemoted ${updated} link(s) from accepted → rejected.`);

  await sequelize.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
