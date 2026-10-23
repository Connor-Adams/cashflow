#!/usr/bin/env tsx
/**
 * Delete Alpha Vantage synthetic dividend rows (import_batch
 * 'alpha_vantage:dividends') written for a holding the account no longer had
 * on the ex-date — closed account, fully sold, or traded to zero. See
 * src/portfolio/repairPhantomDividends.ts; the rule is the reconciler's own
 * positionOnExDate, so this only removes rows the fixed reconciler would not
 * write today.
 *
 * Usage (prod backend container):
 *   tsx scripts/repair-phantom-dividends.ts                  # dry run
 *   tsx scripts/repair-phantom-dividends.ts --apply --expect 42
 *
 * Flags:
 *   (none)        Dry run: counts per account and reason, every id. Writes nothing.
 *   --apply       Delete, in one SQL transaction.
 *   --expect N    With --apply: abort unless exactly N rows are due at write time.
 *
 * Output is ids, dates, amounts and counts only. Recompute the affected tax
 * returns afterwards — a stored TaxReturn snapshot keeps its old lines until
 * the next compute.
 */
import { deletePhantomDividends, scanPhantomDividends } from '../src/portfolio/repairPhantomDividends';
import { runBackfillCli } from './lib/backfillCli';
import { guardWriteTarget, hasFlag, numFlag } from './lib/opsFlags';

async function main(): Promise<void> {
  const apply = hasFlag(process.argv, '--apply');
  const expect = numFlag(process.argv, '--expect');
  guardWriteTarget(apply);

  const due = await scanPhantomDividends();
  console.log(`${due.length} phantom synthetic dividend row(s):`);
  const groups = new Map<string, typeof due>();
  for (const r of due) {
    const key = `account ${r.accountId}, ${r.reason}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [key, rows] of groups) {
    const total = rows.reduce((s, r) => s + r.amount, 0);
    console.log(`  ${key}: ${rows.length} row(s), ${total.toFixed(4)}`);
    for (const r of rows) {
      console.log(`    #${r.id} ${r.exDate} security ${r.securityId} ${r.amount.toFixed(4)} ${r.currency}`);
    }
  }

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply --expect <count> to delete.');
    return;
  }
  const { deleted } = await deletePhantomDividends({ expect });
  console.log(`\nApplied: ${deleted} row(s) deleted.`);
}

runBackfillCli(main);
