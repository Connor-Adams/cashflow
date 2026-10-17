#!/usr/bin/env tsx
/**
 * Remove the duplicate transactions left by Wealthsimple re-imports that reword
 * the same cash event.
 *
 * Two exports of one WS account describe a charge differently — the activities
 * export says "Pre-authorized Debit to AMEX BILL PYMT", the monthly brokerage PDF
 * says "Cash correction (executed at 2026-02-17)". Every dedup tier was anchored
 * on that text, and no WS batch populates `source_reference`, so a re-import of
 * an already-covered date range inserted the whole range again.
 *
 * A 2026-09-29 read-only audit of prod found 40 such pairs under an exact date
 * match and 64 under ±1 day, inflating Feb–Mar 2026 spend by ~$19k and inflow by
 * ~$79k. `2026-06 HQ8H0GZ07CAD` is 10/12 duplicate; `2026-06 WK3DD9X35CAD` is
 * 28/45 — which is also why this is not a `rollbackImportBatch`: those batches
 * carried legitimately-new rows too, so the unit of corruption is the row.
 *
 * The later-written row of each pair is the duplicate (confirmed on every prod
 * pair, and it carries the worse metadata), so the earlier row is kept.
 *
 * Nothing is deleted on a guess. A date cluster holding anything but exactly two
 * rows is reported AMBIGUOUS; a row a human edited, or that owns a receipt or an
 * external-order link, is reported BLOCKED. Both are left in place for you.
 *
 * Safe to re-run: once a duplicate is gone its group holds one row and no pair
 * is found.
 *
 * Usage:
 *   cd backend && npx tsx scripts/remediate-narrative-rename-duplicates.ts --dry-run
 *   cd backend && npx tsx scripts/remediate-narrative-rename-duplicates.ts --dry-run --window 1
 *   cd backend && npx tsx scripts/remediate-narrative-rename-duplicates.ts --apply --window 1
 *
 * Flags:
 *   --dry-run        Report what would change. Writes nothing. DEFAULT.
 *   --apply          Actually delete. Required to change anything.
 *   --window N       Date tolerance in days, 0 or 1 (default 0). 1 also reaches
 *                    the settlement-vs-execution offset cluster.
 *   --household N    Restrict to one household.
 *   --accounts a,b   Restrict to these account ids.
 */
import { sequelize } from '../src/models';
import {
  applyNarrativeRenameRemediation,
  classifyNarrativeRenameDuplicates,
  type ClassifyOptions,
  type RemediationReport,
} from '../src/import/remediateNarrativeRenameDuplicates';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function value(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function money(n: number, currency: string): string {
  return `${n < 0 ? '-' : '+'}${Math.abs(n).toFixed(2)} ${currency}`;
}

function printReport(report: RemediationReport): void {
  console.log(`\nPAIRS TO REMEDIATE: ${report.pairs.length}`);
  if (report.pairs.length > 0) {
    console.log(
      '  acct  amount                 keep(id / date / batch / merchant)   ->   drop(id / date / batch / merchant)   [reason, shift]',
    );
    for (const p of report.pairs) {
      console.log(
        `  ${String(p.accountId).padStart(4)}  ${money(p.amount, p.currency).padStart(20)}  ` +
          `keep ${p.keepId} ${p.keepDate} [${p.keepBatch ?? '-'}] "${p.keepMerchantRaw}"  ->  ` +
          `DROP ${p.dropId} ${p.dropDate} [${p.dropBatch ?? '-'}] "${p.dropMerchantRaw}"  ` +
          `(${p.matchReason}, +${p.dateShiftDays}d)`,
      );
    }
    const byCurrency = new Map<string, { positive: number; negative: number }>();
    for (const p of report.pairs) {
      const acc = byCurrency.get(p.currency) ?? { positive: 0, negative: 0 };
      if (p.amount >= 0) acc.positive += p.amount;
      else acc.negative += p.amount;
      byCurrency.set(p.currency, acc);
    }
    console.log('\n  Overstatement these duplicates account for:');
    for (const [currency, acc] of byCurrency) {
      console.log(
        `    ${currency}: inflow ${acc.positive.toFixed(2)}, outflow ${acc.negative.toFixed(2)}`,
      );
    }
  }

  console.log(`\nAMBIGUOUS (left alone, resolve by hand): ${report.ambiguous.length}`);
  for (const g of report.ambiguous) {
    console.log(
      `  acct ${g.accountId} ${money(g.amount, g.currency)} ids ${g.ids.join(', ')} ` +
        `dates ${g.dates.join(', ')} — ${g.reason}`,
    );
  }

  console.log(`\nBLOCKED (left alone): ${report.blocked.length}`);
  for (const b of report.blocked) {
    console.log(`  drop ${b.dropId} (keep ${b.keepId}) — ${b.reason}`);
  }
}

async function main(): Promise<void> {
  const apply = flag('apply');
  const windowRaw = value('window') ?? '0';
  if (windowRaw !== '0' && windowRaw !== '1') {
    console.error(`--window must be 0 or 1, got ${windowRaw}`);
    process.exitCode = 1;
    return;
  }
  const household = value('household');
  const accounts = value('accounts');
  const opts: ClassifyOptions = {
    windowDays: windowRaw === '1' ? 1 : 0,
    householdId: household != null ? Number(household) : undefined,
    accountIds: accounts != null ? accounts.split(',').map((s) => Number(s.trim())) : undefined,
  };

  console.log(
    `narrative-rename duplicate remediation — ${apply ? 'APPLY (destructive)' : 'DRY RUN'}, ` +
      `window ±${opts.windowDays}d` +
      (opts.householdId != null ? `, household ${opts.householdId}` : '') +
      (opts.accountIds ? `, accounts ${opts.accountIds.join(',')}` : ''),
  );

  if (!apply) {
    printReport(await classifyNarrativeRenameDuplicates(opts));
    console.log('\nNothing was written. Re-run with --apply to delete the DROP rows above.');
    return;
  }

  const result = await applyNarrativeRenameRemediation(opts);
  printReport(result.report);
  console.log(
    `\nDELETED ${result.deletedTransactions} transaction(s): ${result.deletedIds.join(', ')}`,
  );
  console.log(
    `  unlinked transfer pointers: ${result.unlinkedTransactions}` +
      `, receipts: ${result.deletedReceipts}` +
      `, ai suggestions: ${result.deletedAiSuggestions}` +
      `, signals: ${result.deletedTransactionSignals}` +
      `, tax metadata: ${result.deletedTransactionTaxMetadata}` +
      `, budget exclusions: ${result.deletedBudgetExclusions}` +
      `, planned events unlinked: ${result.unlinkedPlannedEvents}`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
