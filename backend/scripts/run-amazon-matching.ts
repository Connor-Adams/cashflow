#!/usr/bin/env tsx
/**
 * Manually trigger `runAmazonMatching` for every household.
 *
 * The nightly `gmail_receipt_scan` job calls this after scanning, and
 * `POST /api/amazon/match/run` calls it on demand, but neither is reachable
 * from a shell. This is the operator's path -- useful after a one-time
 * reprocess/backfill, or to verify a matching change against real data without
 * waiting for 05:00.
 *
 * NOT read-only. `runAmazonMatching` folds duplicate order groups
 * (soft-delete, reversible via `restore()`), creates suggested links, and
 * auto-accepts unambiguous ones at confidence >= 85. Every effect is
 * reversible -- links through `POST /api/amazon/links/:id/reject`, folded
 * orders through `restore()` -- but it is a write.
 *
 * Usage:
 *   cd backend && npx tsx scripts/run-amazon-matching.ts
 */
import { sequelize, HouseholdMember } from '../src/models';
import { runAmazonMatching } from '../src/amazon/matcher';

async function main(): Promise<void> {
  const households = await HouseholdMember.findAll({
    attributes: ['householdId'],
    group: ['householdId'],
  });

  for (const membership of households) {
    const result = await runAmazonMatching({ householdId: membership.householdId });
    console.log(`household ${membership.householdId}: ${JSON.stringify(result)}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
