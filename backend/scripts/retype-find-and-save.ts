#!/usr/bin/env tsx
/**
 * Re-type RBC "Find & Save" sweeps that were stored as grocery purchases,
 * before `detectTypeStage` learned that "TO FIND & SAVE" is money moving into
 * the customer's own Find & Save savings account. Selection and the write live
 * in src/import/retypeFindAndSave.ts; this is only the CLI.
 *
 * Prod at the time of writing (RBC Day to Day Banking 6985): 494 "TO FIND &
 * SAVE" rows typed `purchase` / Groceries (-26,801.00, 2019-06 to 2026-04),
 * plus 2 already `transfer` whose category is not Transfer (#5340 "TO FIND &
 * SAVE" still Groceries; one "AUTO TRANSFER FROM FIND & SAVE" with none).
 * None reviewed or user-edited.
 *
 * Usage (prod backend container):
 *   tsx scripts/retype-find-and-save.ts                      # dry run
 *   tsx scripts/retype-find-and-save.ts --apply --expect 496
 *
 * Flags:
 *   (none)        Dry run. Prints counts, skipped rows, spend impact by year.
 *                 Writes nothing.
 *   --apply       Write, inside one SQL transaction, one instance save per row so
 *                 each gets a TransactionRevision. Requires --expect.
 *   --expect N    With --apply: abort unless the in-transaction scan finds
 *                 exactly N writable rows (re-type + category-only; pass the
 *                 dry-run count).
 *   --verbose     Also list every writable row.
 */
import { sequelize } from '../src/models';
import {
  RetypeAborted,
  applyFindAndSaveRetype,
  scanFindAndSave,
  spendImpactByYear,
  type FindAndSaveRow,
  type FindAndSaveScan,
} from '../src/import/retypeFindAndSave';
import { withRevisionContext } from '../src/util/transactionRevisions';
import { guardWriteTarget, hasFlag, numFlag } from './lib/opsFlags';

function line(r: FindAndSaveRow): string {
  return `    #${r.id} ${r.date} ${r.amount.padStart(10)}  acct ${r.accountId ?? 'null'}  ${r.fromType}/${r.fromCategory ?? 'null'}  "${r.merchantRaw}"`;
}

function sum(rows: FindAndSaveRow[]): string {
  return rows.reduce((s, r) => s + Number(r.amount), 0).toFixed(2);
}

function printScan(scan: FindAndSaveScan, writable: FindAndSaveRow[]): void {
  console.log(`${scan.retype.length} row(s) would become transfer / Transfer (total ${sum(scan.retype)}).`);
  console.log(`${scan.recategorise.length} row(s) already transfer; category would become Transfer.`);
  console.log(`${writable.length} writable row(s) in all  ->  --expect ${writable.length}`);

  console.log(`\n${scan.skipped.length} row(s) skipped (reviewed or edited by a person; never written):`);
  for (const r of scan.skipped) console.log(`${line(r)}  [${r.reasons.join(', ')}]`);

  printSpendImpact(scan.retype);
  if (hasFlag(process.argv, '--verbose')) printRows(writable);
}

function printSpendImpact(retype: FindAndSaveRow[]): void {
  console.log('\nSpend removed by year (rows leaving purchase):');
  for (const y of spendImpactByYear(retype)) {
    console.log(
      `  ${y.year}  ${String(y.count).padStart(4)} rows  ${y.total.toFixed(2).padStart(10)}  avg/month ${(y.total / 12).toFixed(2)}`,
    );
  }
}

function printRows(writable: FindAndSaveRow[]): void {
  console.log('\nWritable rows:');
  for (const r of writable) console.log(line(r));
}

async function applyWrites(expect: number | null): Promise<void> {
  if (expect == null) {
    console.error('--apply requires --expect <count> (the dry-run count). Nothing written.');
    process.exitCode = 1;
    return;
  }
  const { written } = await withRevisionContext({ source: 'system', changedByUserId: null }, () =>
    applyFindAndSaveRetype({ expect }),
  );
  console.log(`\nApplied: ${written} row(s) set to transfer / Transfer.`);
}

async function main(): Promise<void> {
  const apply = hasFlag(process.argv, '--apply');
  guardWriteTarget(apply);

  const scan = await scanFindAndSave();
  printScan(scan, [...scan.retype, ...scan.recategorise]);

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply --expect <count> to write.');
    return;
  }
  await applyWrites(numFlag(process.argv, '--expect'));
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (err) {
    process.exitCode = 1;
    console.error(err instanceof RetypeAborted ? `Aborted: ${err.message}` : err);
  } finally {
    await sequelize.close();
  }
}

void run();
