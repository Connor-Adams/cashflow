#!/usr/bin/env tsx
/**
 * Report transactions that share `(account_id, date, amount)` within a period,
 * classified **certain** or **for review**.
 *
 * Read-only by construction — there is no `--apply`. This part of the plan was
 * scoped back from "detect, supersede and exclude" to detect-and-report: the T1
 * exposure to duplicates is $20.73 (the duplicated RAILWAY row inflating the
 * business-expense total that feeds L13500), and the $28,848.18 phantom on
 * account 13 is corp-side. The detector's value is keeping part 3's dollar
 * figures honest and giving Connor a worklist; neither needs supersession state.
 *
 * "Certain" means structurally invalid, not merely suspicious: every row in the
 * group carries the SAME non-null `linked_transaction_id`, and two legs cannot
 * share one counterpart. Everything else is for review, including the twelve
 * account-14 pairs — matching account, date and amount describes two $6.00 RBC
 * monthly fees just as well as it describes a re-import.
 *
 * Expect to re-run this. `dedupExisting.ts` already checks every existing row in
 * the account by identity fingerprint at import time, so these pairs exist because
 * two runs produced DIFFERENT fingerprints for the same row — the fingerprint
 * hashes `merchantRaw`, and Wealthsimple relabels descriptions between statement
 * cycles. For sources with no stable `sourceReference` that is not fully
 * preventable, which makes a cheap retroactive detector a permanent need.
 *
 * Usage:
 *   cd backend && npx tsx scripts/detect-duplicate-transactions.ts --household 1 --year 2026
 *   cd backend && npx tsx scripts/detect-duplicate-transactions.ts --household 1 --from 2026-01-01 --to 2026-06-30
 *
 * Flags:
 *   --household N      Household id. REQUIRED — an unbounded scan is refused.
 *   --year YYYY        Shorthand for --from YYYY-01-01 --to YYYY-12-31.
 *   --from YYYY-MM-DD  Period start, inclusive.
 *   --to YYYY-MM-DD    Period end, inclusive.
 *   --entity N         Narrow to one entity.
 *   --accounts a,b,c   Narrow to specific account ids.
 *   --json             Emit the report as JSON instead of a table.
 */
import { sequelize } from '../src/models';
import { detectDuplicateTransactions } from '../src/import/detectDuplicateTransactions';
import type { DuplicateGroup } from '../src/import/classifyDuplicateGroup';

function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function num(name: string): number | undefined {
  const raw = opt(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`--${name} must be an integer, got ${raw}`);
  return n;
}

function printGroups(label: string, groups: DuplicateGroup[]): void {
  if (groups.length === 0) return;
  console.log(`\n${label} (${groups.length})`);
  for (const g of groups) {
    console.log(
      `  acct ${g.accountId}  ${g.date}  ${g.amount}  `
      + `txns ${g.rows.map((r) => r.id).join('/')}  overstates ${g.duplicatedAmount}`,
    );
    for (const reason of g.reasons) console.log(`      - ${reason}`);
  }
}

async function main(): Promise<void> {
  const householdId = num('household');
  if (householdId === undefined) {
    console.error('--household is required. An unbounded whole-ledger scan is refused.');
    process.exitCode = 1;
    return;
  }

  const year = num('year');
  const startDate = opt('from') ?? (year !== undefined ? `${year}-01-01` : undefined);
  const endDate = opt('to') ?? (year !== undefined ? `${year}-12-31` : undefined);
  if (!startDate || !endDate) {
    console.error('Give a period: --year YYYY, or --from and --to.');
    process.exitCode = 1;
    return;
  }

  const accounts = opt('accounts');
  const report = await detectDuplicateTransactions({
    householdId,
    startDate,
    endDate,
    entityId: num('entity'),
    accountIds: accounts ? accounts.split(',').map((s) => Number(s.trim())) : undefined,
  });

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Duplicate scan  household ${householdId}  ${startDate}..${endDate}`);
  console.log(`  groups: ${report.groups.length}  certain: ${report.certain.length}  for review: ${report.review.length}`);
  console.log(`  ledger overstates by: ${report.totalDuplicatedAmount}`);
  printGroups('CERTAIN — every row shares one linked_transaction_id', report.certain);
  printGroups('FOR REVIEW', report.review);
  if (report.groups.length > 0) {
    console.log('\nNothing was changed. Clear these by hand in the transaction list.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
