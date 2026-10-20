#!/usr/bin/env tsx
/**
 * Re-type brokerage funding that was stored as a card payment, before
 * `detectTypeStage` learned that "ONLINE BANKING PAYMENT - … QUESTRADE" and
 * "MISC PAYMENT QUESTRADE" are money moving to/from a brokerage account.
 * Selection and the write live in src/import/retypeBrokerageFunding.ts; this is
 * only the CLI.
 *
 * Prod at the time of writing: 7 rows on RBC Day to Day Banking 6985 — six
 * "ONLINE BANKING PAYMENT - #### QUESTRADE" contributions and one
 * "MISC PAYMENT QUESTRADE" withdrawal — all typed `payment`.
 *
 * Usage (prod backend container):
 *   tsx scripts/retype-brokerage-funding.ts                    # dry run
 *   tsx scripts/retype-brokerage-funding.ts --apply --expect 7
 *
 * Flags:
 *   (none)        Dry run. Prints counts by narrative and account. Writes nothing.
 *   --apply       Write, inside one SQL transaction, one instance save per row so
 *                 each gets a TransactionRevision. Requires --expect.
 *   --expect N    With --apply: abort unless the in-transaction scan finds
 *                 exactly N rows (pass the dry-run count).
 *   --verbose     Also list every row id.
 */
import { sequelize } from '../src/models';
import {
  RetypeAborted,
  applyBrokerageFundingRetype,
  scanBrokerageFundingRetype,
  summarizeBrokerageRetype,
} from '../src/import/retypeBrokerageFunding';
import { withRevisionContext } from '../src/util/transactionRevisions';
import { guardWriteTarget, hasFlag, numFlag } from './lib/opsFlags';

async function main(): Promise<void> {
  const apply = hasFlag(process.argv, '--apply');
  const expect = numFlag(process.argv, '--expect');
  guardWriteTarget(apply);

  const rows = await scanBrokerageFundingRetype();
  console.log(`${rows.length} row(s) typed 'payment' would become 'transfer':`);
  for (const g of summarizeBrokerageRetype(rows)) {
    console.log(`  ${String(g.count).padStart(4)}  account ${g.accountId ?? 'null'}  "${g.narrative}"`);
  }
  if (hasFlag(process.argv, '--verbose')) {
    for (const r of rows) console.log(`    #${r.id} ${r.date} ${r.amount}  "${r.merchantRaw}"`);
  }

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply --expect <count> to write.');
    return;
  }
  if (expect == null) {
    console.error('--apply requires --expect <count> (the dry-run count). Nothing written.');
    process.exitCode = 1;
    return;
  }

  const { retyped } = await withRevisionContext({ source: 'system', changedByUserId: null }, () =>
    applyBrokerageFundingRetype({ expect }),
  );
  console.log(`\nApplied: ${retyped} row(s) re-typed to 'transfer'.`);
}

main()
  .catch((err) => {
    console.error(err instanceof RetypeAborted ? `Aborted: ${err.message}` : err);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
