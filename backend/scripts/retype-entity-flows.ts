#!/usr/bin/env tsx
/**
 * Re-type company-account inflows the entity rules now decide (see
 * src/import/retypeEntityFlows.ts): a company moving its own money becomes
 * `transfer`, a client paying the company becomes `income`.
 *
 * Usage (prod backend container):
 *   tsx scripts/retype-entity-flows.ts                 # dry run
 *   tsx scripts/retype-entity-flows.ts --apply --expect 34
 *
 * Flags:
 *   (none)        Dry run: counts per transition and per account, every id. Writes nothing.
 *   --apply       Write, in one SQL transaction, one TransactionRevision per row.
 *   --expect N    With --apply: abort unless exactly N rows are due at write time.
 *
 * Output is ids, dates, amounts and counts only.
 */
import { applyEntityFlowRetypes, scanEntityFlowRetypes } from '../src/import/retypeEntityFlows';
import { asSystem, runBackfillCli } from './lib/backfillCli';
import { guardWriteTarget, hasFlag, numFlag } from './lib/opsFlags';

async function main(): Promise<void> {
  const apply = hasFlag(process.argv, '--apply');
  const expect = numFlag(process.argv, '--expect');
  guardWriteTarget(apply);

  const due = await scanEntityFlowRetypes();
  console.log(`${due.length} company-account row(s) to re-type:`);
  const groups = new Map<string, typeof due>();
  for (const r of due) {
    const key = `${r.from} -> ${r.to} (account ${r.accountId})`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [key, rows] of groups) {
    const total = rows.reduce((s, r) => s + r.amount, 0);
    console.log(`  ${key}: ${rows.length} row(s), ${total.toFixed(2)}`);
    for (const r of rows) console.log(`    #${r.id} ${r.date} ${r.amount.toFixed(2)}`);
  }

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply --expect <count> to write.');
    return;
  }
  const { retyped } = await asSystem(() => applyEntityFlowRetypes({ expect }));
  console.log(`\nApplied: ${retyped} row(s) re-typed.`);
}

runBackfillCli(main);
