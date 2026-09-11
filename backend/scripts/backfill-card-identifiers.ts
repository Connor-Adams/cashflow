#!/usr/bin/env tsx
/**
 * One-time backfill of `account_card_identifiers`
 * (docs/superpowers/specs/2026-09-11-account-card-identifiers-design.md,
 * Part 3).
 *
 * The import-time harvest hooks (PDF statement headers, receipt tenders)
 * only fire going forward. This walks every `ExternalOrder` already sitting
 * on a deterministic-source (`DETERMINISTIC_RECEIPT_SOURCES` in
 * backend/src/amazon/cardOwnership.ts) and upserts an identifier for each
 * (account, last4) pair reachable through its `TransactionOrderLink` rows.
 *
 * Against production this is expected to write exactly TWO new rows, both
 * legitimate: account 5 (Costco MC) -> 3114 (order 399's tender, accepted
 * link), and account 14 (Wealthsimple Chequing) -> 3812 (order 398's tender
 * 3812/$1863.72, paired by linked_amount to an accepted link on account 14 --
 * a split-tender Costco purchase). Every other account's last-4 is already
 * recoverable from `short_code`, so a run reporting more than these two has
 * over-harvested and should be investigated before applying -- see the
 * design doc's "source filter that makes this safe".
 *
 * Idempotent: safe to re-run. A second run reports zero new rows.
 *
 * Usage:
 *   cd backend && npx tsx scripts/backfill-card-identifiers.ts --dry-run
 *   cd backend && npx tsx scripts/backfill-card-identifiers.ts --apply
 *
 * Flags:
 *   --dry-run   Report what would be written. Write nothing. DEFAULT.
 *   --apply     Actually write. Required to make any change.
 */
import { sequelize } from '../src/models';
import { backfillAccountCardIdentifiers } from '../src/import/cardIdentifierBackfill';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const apply = flag('apply');
  const report = await backfillAccountCardIdentifiers({ dryRun: !apply });

  console.log(
    `${report.candidates.length} candidate (account, last4) sighting(s) from deterministic ` +
      `receipt sources; ${report.newRows.length} new pair(s).`,
  );
  for (const row of report.newRows) {
    console.log(
      `  NEW  account ${row.accountId} -> ${row.last4}  (order ${row.externalOrderId}, source ${row.source})`,
    );
  }
  for (const row of report.candidates.filter((r) => r.alreadyExists)) {
    console.log(
      `  already known  account ${row.accountId} -> ${row.last4}  (order ${row.externalOrderId}, source ${row.source})`,
    );
  }

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply to make these changes.');
  } else {
    console.log(`\nApplied: wrote ${report.newRows.length} new identifier row(s).`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
