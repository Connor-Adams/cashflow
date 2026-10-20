#!/usr/bin/env tsx
/**
 * Classify every remaining half-linked transfer pair (safe / cleared_by_job /
 * ambiguous) and close the classes you name. Logic lives in
 * src/transfers/backfillHalfLinkedTransfers.ts; this is only the CLI.
 *
 * Usage (prod backend container):
 *   tsx scripts/backfill-half-linked-transfers.ts                    # dry run, all classes
 *   tsx scripts/backfill-half-linked-transfers.ts --apply --classes safe --expect 79
 *   tsx scripts/backfill-half-linked-transfers.ts --apply --classes safe,cleared_by_job --expect 99
 *
 * Flags:
 *   (none)          Dry run. Per-class counts, B types, ambiguous reasons, example
 *                   id pairs. Writes nothing.
 *   --apply         Write, in one SQL transaction. Requires --classes.
 *   --classes LIST  Comma-separated: safe, cleared_by_job. `ambiguous` is refused.
 *   --expect N      With --apply: abort unless exactly N pairs are in the chosen
 *                   classes at write time (pass the dry-run total for them).
 *
 * Output is ids and counts only.
 */
import { sequelize } from '../src/models';
import { BackfillAborted } from '../src/transfers/backfillHalfLinkedCsvTransfers';
import {
  applyHalfLinkedTransferBackfill,
  classifyHalfLinkedTransfers,
  summarizeByClass,
  type HalfLinkClass,
} from '../src/transfers/backfillHalfLinkedTransfers';
import { withRevisionContext } from '../src/util/transactionRevisions';
import { guardWriteTarget, hasFlag, numFlag, strFlag } from './lib/opsFlags';

type Closable = Exclude<HalfLinkClass, 'ambiguous'>;
const CLOSABLE: Closable[] = ['safe', 'cleared_by_job'];

function parseClasses(raw: string | null): Closable[] {
  if (raw == null) return [];
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = names.filter((n) => !(CLOSABLE as string[]).includes(n));
  if (bad.length > 0) throw new Error(`--classes accepts ${CLOSABLE.join(', ')}; got ${bad.join(', ')}`);
  return names as Closable[];
}

async function main(): Promise<void> {
  const apply = hasFlag(process.argv, '--apply');
  const classes = parseClasses(strFlag(process.argv, '--classes'));
  const expectPairs = numFlag(process.argv, '--expect');
  guardWriteTarget(apply);

  const rows = await classifyHalfLinkedTransfers();
  console.log(`${rows.length} half-linked transfer pair(s):`);
  for (const s of summarizeByClass(rows)) {
    const examples = s.examples.map(([a, b]) => `${a}->${b}`).join(', ');
    console.log(
      `  ${s.cls}: ${s.pairs} pair(s), ${s.aStamped} forward stamp(s), ` +
        `${s.bRetyped} sibling(s) re-typed to transfer; sibling types ${JSON.stringify(s.bTypes)}` +
        (s.cls === 'ambiguous' ? `; reasons ${JSON.stringify(s.reasons)}` : '') +
        (examples ? `; e.g. ${examples}` : ''),
    );
  }

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply --classes <list> --expect <count> to write.');
    return;
  }
  if (classes.length === 0) throw new Error('--apply needs --classes (safe, cleared_by_job)');

  const { fixed } = await withRevisionContext({ source: 'system', changedByUserId: null }, () =>
    applyHalfLinkedTransferBackfill({ classes, expectPairs }),
  );
  console.log(`\nApplied: ${fixed} pair(s) linked both ways (${classes.join(', ')}).`);
}

main()
  .catch((err) => {
    console.error(err instanceof BackfillAborted ? `Aborted: ${err.message}` : err);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
