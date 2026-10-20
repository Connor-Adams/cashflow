#!/usr/bin/env tsx
/**
 * Close the half-linked transfer pairs whose forward leg came from a direct CSV
 * upload: write the reverse pointer and `transfer_linked_at` the shared import
 * builder now writes at insert time. Selection and the write live in
 * src/transfers/backfillHalfLinkedCsvTransfers.ts; this is only the CLI.
 *
 * Prod at the time of writing: 33 pairs in household 1, all from one RBC
 * `download-transactions.csv` (RBC "AMEX BILL PYMT" → Amex "PAYMENT RECEIVED").
 *
 * Usage (prod backend container):
 *   tsx scripts/backfill-csv-transfer-links.ts                     # dry run
 *   tsx scripts/backfill-csv-transfer-links.ts --apply --expect 33
 *
 * Flags:
 *   (none)        Dry run. Prints counts and example id pairs. Writes nothing.
 *   --apply       Write, inside one SQL transaction. The scan is repeated inside
 *                 that transaction and must come back empty before it commits.
 *   --expect N    With --apply: abort unless the in-transaction scan finds
 *                 exactly N pairs (pass the dry-run count).
 *
 * Output is ids and counts only.
 */
import { sequelize } from '../src/models';
import {
  BackfillAborted,
  applyHalfLinkedCsvTransferBackfill,
  scanHalfLinkedCsvTransfers,
  summarizeByHousehold,
} from '../src/transfers/backfillHalfLinkedCsvTransfers';
import { withRevisionContext } from '../src/util/transactionRevisions';
import { guardWriteTarget, hasFlag, numFlag } from './lib/opsFlags';

async function main(): Promise<void> {
  const apply = hasFlag(process.argv, '--apply');
  const expectPairs = numFlag(process.argv, '--expect');
  guardWriteTarget(apply);

  const { pairs, skipped } = await scanHalfLinkedCsvTransfers();
  const summaries = summarizeByHousehold(pairs);
  console.log(`${pairs.length} half-linked CSV transfer pair(s) to close:`);
  for (const s of summaries) {
    const examples = s.examples.map(([a, b]) => `${a}->${b}`).join(', ');
    console.log(
      `  household ${s.householdId ?? 'null'}: ${s.pairs} pair(s), ` +
        `${s.pairs} reverse pointer(s), ${s.aStamped} forward stamp(s), ` +
        `${s.bRetyped} sibling(s) re-typed to transfer; e.g. ${examples}`,
    );
  }
  console.log('Skipped:', JSON.stringify(skipped));

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply --expect <count> to write.');
    return;
  }
  if (pairs.length === 0) return;

  const { fixed } = await withRevisionContext({ source: 'system', changedByUserId: null }, () =>
    applyHalfLinkedCsvTransferBackfill({ expectPairs }),
  );
  console.log(`\nApplied: ${fixed} pair(s) linked both ways.`);
}

main()
  .catch((err) => {
    console.error(err instanceof BackfillAborted ? `Aborted: ${err.message}` : err);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
