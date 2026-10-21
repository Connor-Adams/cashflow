#!/usr/bin/env tsx
/**
 * Flag rows on corporation-owned accounts as business (logic and limits in
 * src/import/defaultCorpBusiness.ts). Rows with a per-row businessOverride are
 * never touched.
 *
 * Usage (prod backend container), AFTER scripts/retype-entity-flows.ts --apply:
 *   tsx scripts/default-corp-business.ts                  # dry run
 *   tsx scripts/default-corp-business.ts --apply --expect N
 *
 * Flags:
 *   (none)        Dry run: counts per account and txn type. Writes nothing.
 *   --apply       Write, in one SQL transaction, one TransactionRevision per row.
 *                 Refuses while retype-entity-flows still has rows to re-type.
 *   --expect N    With --apply: abort unless exactly N rows are due at write time.
 *
 * Output is ids, counts and amounts only.
 */
import { applyCorpBusinessDefaults, scanCorpBusinessDefaults } from '../src/import/defaultCorpBusiness';
import { asSystem, runBackfillCli } from './lib/backfillCli';
import { guardWriteTarget, hasFlag, numFlag } from './lib/opsFlags';

async function main(): Promise<void> {
  const apply = hasFlag(process.argv, '--apply');
  const expect = numFlag(process.argv, '--expect');
  guardWriteTarget(apply);

  const due = await scanCorpBusinessDefaults();
  console.log(`${due.length} corp-account row(s) to flag as business:`);
  const groups = new Map<string, { n: number; sum: number; ids: number[] }>();
  for (const r of due) {
    const key = `account ${r.accountId} | ${r.txnType} | ${r.currency}`;
    const g = groups.get(key) ?? { n: 0, sum: 0, ids: [] };
    g.n += 1;
    g.sum += r.amount;
    g.ids.push(r.id);
    groups.set(key, g);
  }
  for (const [key, g] of [...groups].sort()) {
    console.log(`  ${key}: ${g.n} row(s), ${g.sum.toFixed(2)}; e.g. ${g.ids.slice(0, 5).join(', ')}`);
  }

  if (!apply) {
    console.log('\nDry run — nothing written. Run retype-entity-flows first, then --apply --expect <count>.');
    return;
  }
  const { flagged } = await asSystem(() => applyCorpBusinessDefaults({ expect }));
  console.log(`\nApplied: ${flagged} row(s) flagged business.`);
}

runBackfillCli(main);
