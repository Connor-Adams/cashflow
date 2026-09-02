#!/usr/bin/env tsx
/**
 * Clean up the `investment_activities` rows sitting on Wealthsimple deposit
 * accounts (Cash / Chequing / Save).
 *
 * Those accounts share the brokerage statement layout, so until the routing fix
 * their cash rows were filed as investment activity. Re-importing on top of an
 * already-populated ledger then left two states at once:
 *
 *   SHADOW  a transaction already records the event, with better merchant text
 *           ("Withdrawal (executed at ...)" beside "Pre-authorized Debit to
 *           AMEX BILL PYMT") → the activity row is redundant, delete it.
 *   ORPHAN  nothing records it. A real cash event missing from the ledger →
 *           convert it to a transaction.
 *
 * Prod at the time of writing: 190 shadows and 66 orphans across accounts 14
 * (WS Chequing), 16 (Save for Business) and 24 (Corporate Chequing).
 *
 * Orphans are inserted through the normal commit pipeline, so they get real
 * enrichment, dedup, fingerprints and an ImportHistory row — and the narrative
 * detector classifies them, so an orphaned "Pre-authorized Debit to AMEX BILL
 * PYMT" lands as `payment` rather than `transfer`.
 *
 * Safe to re-run. The insert precedes the delete, so an interrupted run leaves
 * converted orphans still present as activities; the next run sees them as
 * shadows of the transactions just created and removes them.
 *
 * Usage:
 *   cd backend && npx tsx scripts/migrate-ws-deposit-activities.ts --dry-run
 *   cd backend && npx tsx scripts/migrate-ws-deposit-activities.ts --apply
 *
 * Flags:
 *   --dry-run          Report what would change. Write nothing. DEFAULT.
 *   --apply            Actually write. Required to make any change.
 *   --accounts a,b,c   Account ids to process (default: 14,16,24).
 *   --user-id N        Stamp inserted rows as created by this user.
 *   --verbose          List every classified row.
 */
import { sequelize } from '../src/models';
import {
  classifyWsDepositActivities,
  migrateWsDepositActivities,
} from '../src/import/wsDepositActivityMigration';

const DEFAULT_ACCOUNTS = [14, 16, 24];

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function value(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function money(n: number): string {
  return n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function main(): Promise<void> {
  const apply = flag('apply');
  const verbose = flag('verbose');
  const accountIds = (value('accounts') ?? DEFAULT_ACCOUNTS.join(','))
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const userIdRaw = value('user-id');
  const userId = userIdRaw ? Number(userIdRaw) : null;

  if (accountIds.length === 0) {
    console.error('No valid account ids given.');
    process.exitCode = 1;
    return;
  }

  const { shadows, orphans, skipped } = await classifyWsDepositActivities(accountIds);

  console.log(`Accounts: ${accountIds.join(', ')}`);
  console.log(`  shadows (delete):  ${shadows.length}`);
  console.log(`  orphans (convert): ${orphans.length}`);
  if (skipped.length > 0) {
    console.log(`  skipped (has a security, left alone): ${skipped.length}`);
  }

  for (const accountId of accountIds) {
    const s = shadows.filter((x) => x.accountId === accountId);
    const o = orphans.filter((x) => x.accountId === accountId);
    if (s.length === 0 && o.length === 0) continue;
    const gross = s.reduce((acc, x) => acc + Math.abs(x.amount), 0);
    console.log(
      `  account ${accountId}: ${s.length} shadow(s) worth ${money(gross)} gross, ` +
        `${o.length} orphan(s)`,
    );
  }

  if (verbose) {
    for (const s of shadows) {
      console.log(
        `    SHADOW acct ${s.accountId} ${s.date} ${money(s.amount)} ` +
          `"${s.description}" → txn ${s.transactionId} "${s.transactionMerchantRaw}"`,
      );
    }
    for (const o of orphans) {
      console.log(
        `    ORPHAN acct ${o.accountId} ${o.date} ${money(o.amount)} ` +
          `"${o.description}" → ${o.txnType ?? '(narrative decides)'}`,
      );
    }
  }

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply to make these changes.');
    return;
  }

  const report = await migrateWsDepositActivities({ accountIds, userId });
  console.log('\nApplied:');
  console.log(`  transactions inserted: ${report.insertedTransactions}`);
  console.log(`  already present (deduped): ${report.skippedDuplicates}`);
  console.log(`  activity rows deleted: ${report.deletedShadows + report.orphans.length}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
