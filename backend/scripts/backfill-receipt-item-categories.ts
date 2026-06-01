#!/usr/bin/env tsx
/**
 * Backfill inferredCategory on non-Amazon receipt line items that were imported
 * before AI categorization existed (e.g. Costco till-receipt PDFs, which the
 * parser leaves null). Runs the AI categorizer per household over its
 * null-category, non-Amazon items.
 *
 * Usage:
 *   cd backend && DATABASE_URL=... npx tsx scripts/backfill-receipt-item-categories.ts          # dry-run
 *   cd backend && DATABASE_URL=... npx tsx scripts/backfill-receipt-item-categories.ts --commit # write
 *
 * Prod Postgres only (per project convention). Without DATABASE_URL this hits
 * local sqlite — do not run the backfill that way.
 */
import { Op } from 'sequelize';
import { ExternalOrder, ExternalOrderItem, sequelize } from '../src/models';
import { categorizeAndApplyReceiptItems } from '../src/import/categorizeReceiptItems';
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

  // Households that own at least one null-category, non-Amazon receipt item.
  const pending = await ExternalOrderItem.findAll({
    where: { inferredCategory: null },
    include: [
      {
        model: ExternalOrder,
        as: 'order',
        where: { vendor: { [Op.ne]: 'amazon' }, householdId: { [Op.ne]: null } },
        required: true,
        attributes: ['householdId'],
      },
    ],
    attributes: ['id'],
  });

  const householdIds = Array.from(
    new Set(
      pending
        .map((it) => (it.get('order') as ExternalOrder | undefined)?.householdId)
        .filter((id): id is number => id != null),
    ),
  );

  console.log(
    `${pending.length} uncategorized item(s) across ${householdIds.length} household(s).${
      COMMIT ? '' : '  [dry-run — pass --commit to write]'
    }`,
  );

  if (!COMMIT) {
    await sequelize.close();
    return;
  }

  let totalUpdated = 0;
  for (const householdId of householdIds) {
    let pass = 0;
    for (;;) {
      const updated = await categorizeAndApplyReceiptItems({ householdId, limit: 500 });
      totalUpdated += updated;
      pass += 1;
      console.log(`  household ${householdId}: pass ${pass} categorized ${updated} item(s)`);
      if (updated === 0) break;
    }
  }

  console.log(`\nCategorized ${totalUpdated} item(s).`);
  await sequelize.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
