/**
 * The shared shape of the one-off data repairs: plan, check the plan against
 * what a person approved, write, and re-plan to prove nothing is left — all in
 * one SQL transaction so a racing edit cannot land between the count and the
 * write, and a half-done repair rolls back.
 */
import type { Transaction as DbTransaction } from 'sequelize';
import { sequelize } from '../models';
import { BackfillAborted } from '../transfers/backfillHalfLinkedCsvTransfers';

export async function runPlannedWrites<T>(opts: {
  plan: (t: DbTransaction) => Promise<T[]>;
  write: (item: T, t: DbTransaction) => Promise<void>;
  /** Abort unless exactly this many items are planned at write time. */
  expect?: number | null;
  /** Refuse to write at all; returns the reason, or null to proceed. */
  precondition?: (t: DbTransaction) => Promise<string | null>;
}): Promise<{ written: number }> {
  return sequelize.transaction(async (t) => {
    const refused = opts.precondition ? await opts.precondition(t) : null;
    if (refused) throw new BackfillAborted(`${refused}; nothing written`);
    const planned = await opts.plan(t);
    if (opts.expect != null && planned.length !== opts.expect) {
      throw new BackfillAborted(`expected ${opts.expect} row(s), found ${planned.length}; nothing written`);
    }
    for (const item of planned) await opts.write(item, t);
    const left = await opts.plan(t);
    if (left.length !== 0) {
      throw new BackfillAborted(`${left.length} row(s) still due after the writes; rolled back`);
    }
    return { written: planned.length };
  });
}
