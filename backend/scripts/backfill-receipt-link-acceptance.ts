#!/usr/bin/env tsx
/**
 * Backfill auto-acceptance for receipt→transaction links created before the
 * auto-accept feature. Finds every ExternalOrder that still has a 'suggested'
 * TransactionOrderLink and re-runs matchReceiptOrderToTransactions, which
 * upgrades qualifying suggested links to 'accepted' (monotonic — never
 * downgrades 'accepted'/'rejected').
 *
 * Usage:
 *   cd backend && DATABASE_URL=... npx tsx scripts/backfill-receipt-link-acceptance.ts          # dry-run
 *   cd backend && DATABASE_URL=... npx tsx scripts/backfill-receipt-link-acceptance.ts --commit # write
 *
 * Prod Postgres only (per project convention). Without DATABASE_URL this hits
 * local sqlite — do not run the backfill that way.
 */
import { Op } from 'sequelize';
import { ExternalOrder, TransactionOrderLink, sequelize } from '../src/models';
import { matchReceiptOrderToTransactions } from '../src/import/matchReceiptToTransactions';
import { databaseUrl } from '../src/config/env';

const COMMIT = process.argv.includes('--commit');

async function acceptedCount(orderId: number): Promise<number> {
  return TransactionOrderLink.count({ where: { externalOrderId: orderId, status: 'accepted' } });
}

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
  const suggested = await TransactionOrderLink.findAll({
    where: { status: 'suggested' },
    attributes: ['externalOrderId'],
    group: ['externalOrderId'],
  });
  const orderIds = suggested.map((l) => l.externalOrderId);
  const orders = await ExternalOrder.findAll({ where: { id: { [Op.in]: orderIds } }, order: [['id', 'ASC']] });

  console.log(`${orders.length} order(s) with suggested link(s).${COMMIT ? '' : '  [dry-run — pass --commit to write]'}`);

  let upgradedLinks = 0;
  for (const order of orders) {
    if (order.householdId == null) {
      console.log(`  order ${order.id}: skipped (no householdId)`);
      continue;
    }
    const before = await acceptedCount(order.id);
    if (!COMMIT) {
      console.log(`  order ${order.id} (${order.vendor}, ${order.orderDate}): would re-match; currently ${before} accepted`);
      continue;
    }
    await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId: order.householdId });
    const after = await acceptedCount(order.id);
    upgradedLinks += Math.max(0, after - before);
    console.log(`  order ${order.id} (${order.vendor}, ${order.orderDate}): accepted ${before} → ${after}`);
  }

  if (COMMIT) console.log(`\nUpgraded ${upgradedLinks} link(s) to accepted.`);
  await sequelize.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
