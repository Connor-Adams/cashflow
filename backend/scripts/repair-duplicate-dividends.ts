#!/usr/bin/env tsx
/**
 * Remove Alpha Vantage synthetic dividend rows (import_batch
 * 'alpha_vantage:dividends') that duplicate a payout the broker already
 * recorded: a broker dividend on the pay date, or a security-less
 * distribution of the same amount. See src/portfolio/repairDuplicateDividends.ts.
 * The match is the reconciler's own findBrokerPayout, so this only removes
 * rows the fixed reconciler would not write today.
 *
 * Usage (prod backend container):
 *   tsx scripts/repair-duplicate-dividends.ts                  # dry run
 *   tsx scripts/repair-duplicate-dividends.ts --apply --expect 42
 *
 * Flags:
 *   (none)        Dry run: counts per account and match kind, every pair. Writes nothing.
 *   --apply       Delete the synthetic rows, retyping each matched security-less
 *                 broker row to 'dividend' first, all in one SQL transaction.
 *   --expect N    With --apply: abort unless exactly N rows are due at write time.
 *
 * Independent of repair-phantom-dividends.ts: rows for a holding the account
 * no longer had are left to that script, so either can run first.
 *
 * Output is ids, dates, amounts and counts only. Recompute the affected tax
 * returns afterwards — a stored TaxReturn snapshot keeps its old lines until
 * the next compute.
 */
import { removeDuplicateDividends, scanDuplicateDividends } from '../src/portfolio/repairDuplicateDividends';
import { runBackfillCli } from './lib/backfillCli';
import { guardWriteTarget, hasFlag, numFlag } from './lib/opsFlags';

async function main(): Promise<void> {
  const apply = hasFlag(process.argv, '--apply');
  const expect = numFlag(process.argv, '--expect');
  guardWriteTarget(apply);

  const due = await scanDuplicateDividends();
  console.log(`${due.length} synthetic dividend row(s) duplicating a broker record:`);
  const groups = new Map<string, typeof due>();
  for (const d of due) {
    const key = `account ${d.accountId}, broker ${d.broker.match}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  for (const [key, rows] of groups) {
    const total = rows.reduce((s, d) => s + d.amount, 0);
    console.log(`  ${key}: ${rows.length} row(s), ${total.toFixed(4)}`);
    for (const d of rows) {
      console.log(
        `    #${d.id} ${d.exDate} security ${d.securityId} ${d.amount.toFixed(4)} ${d.currency}`
        + ` = broker #${d.broker.id} ${d.broker.tradeDate} ${d.broker.amount.toFixed(4)}`,
      );
    }
  }

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply --expect <count> to remove.');
    return;
  }
  const { removed } = await removeDuplicateDividends({ expect });
  console.log(`\nApplied: ${removed} synthetic row(s) removed.`);
}

runBackfillCli(main);
