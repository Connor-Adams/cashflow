#!/usr/bin/env tsx
/**
 * One-shot READ-ONLY enrichment audit probe (created 2026-05-23 during the
 * detect-type / merge fixes work). Reports the distributions and bug-suspect
 * rows that justify the changes shipped in this branch. Safe to run repeatedly
 * — only SELECTs.
 *
 * Run against prod via:
 *   PUBURL=$(railway variables --service backend --environment production --json | jq -r .DATABASE_PUBLIC_URL)
 *   DATABASE_URL="$PUBURL" NODE_ENV=production npx tsx scripts/probeEnrichmentGaps.ts
 */
import { sequelize } from '../src/models';
import { QueryTypes } from 'sequelize';

async function main() {
  const total = await sequelize.query<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM transactions',
    { type: QueryTypes.SELECT },
  );
  console.log(`total transactions: ${total[0]?.n}`);

  const types = await sequelize.query<{ txn_type: string; n: number }>(
    'SELECT txn_type, COUNT(*)::int AS n FROM transactions GROUP BY txn_type ORDER BY n DESC',
    { type: QueryTypes.SELECT },
  );
  console.log('\n=== txn_type distribution ===');
  console.log(types);

  const enrichDist = await sequelize.query<{ auto_source: string | null; auto_confidence: string | null; review_flag: boolean; n: number }>(
    'SELECT auto_source, auto_confidence, review_flag, COUNT(*)::int AS n FROM transactions GROUP BY 1,2,3 ORDER BY n DESC LIMIT 30',
    { type: QueryTypes.SELECT },
  );
  console.log('\n=== enrichment outcome distribution ===');
  console.log(enrichDist);

  const recurringBug = await sequelize.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM transactions WHERE auto_source='recurring' AND auto_confidence IS NULL",
    { type: QueryTypes.SELECT },
  );
  console.log(`\nauto_source='recurring' with NULL auto_confidence: ${recurringBug[0]?.n} (was 12)`);

  const unknownRemaining = await sequelize.query<{ merchant_raw: string; n: number }>(
    "SELECT merchant_raw, COUNT(*)::int AS n FROM transactions WHERE txn_type='unknown' GROUP BY merchant_raw ORDER BY n DESC LIMIT 15",
    { type: QueryTypes.SELECT },
  );
  console.log('\n=== txn_type=unknown remaining (top 15) ===');
  for (const r of unknownRemaining) console.log(`  ${r.n}x ${JSON.stringify(r.merchant_raw)}`);

  await sequelize.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
