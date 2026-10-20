import type { Sequelize } from 'sequelize';
import { InvestmentActivity } from '../models/InvestmentActivity';
import { markDailySnapshotsStaleForHousehold } from '../portfolio/dailySnapshotBuilder';
import { hookTransaction, householdIdForRow } from './hookTransaction';

/**
 * Drop the household's cached daily snapshots from `fromDate` forward, inside
 * the hooked write's own transaction — see hookTransaction.ts for why it is not
 * deferred to afterCommit.
 */
async function dropSnapshotsFrom(inv: InvestmentActivity, opts: unknown, fromDate: string): Promise<void> {
  const t = hookTransaction(opts);
  const hhId = await householdIdForRow(inv, t);
  if (hhId == null) return;
  await markDailySnapshotsStaleForHousehold(hhId, fromDate, t);
}

let registered = false;

export function registerDailySnapshotStaleHooks(_sequelize: Sequelize): void {
  if (registered) return;
  registered = true;

  InvestmentActivity.addHook('afterCreate', 'daily_snapshot_stale_create', async (instance, opts) => {
    const inv = instance as InvestmentActivity;
    await dropSnapshotsFrom(inv, opts, inv.tradeDate);
  });

  InvestmentActivity.addHook('afterUpdate', 'daily_snapshot_stale_update', async (instance, opts) => {
    const inv = instance as InvestmentActivity;
    const newDate = inv.tradeDate;
    const prev = (inv.previous as (key: string) => string | undefined)('tradeDate');
    await dropSnapshotsFrom(inv, opts, prev && prev < newDate ? prev : newDate);
  });

  InvestmentActivity.addHook('afterDestroy', 'daily_snapshot_stale_destroy', async (instance, opts) => {
    const inv = instance as InvestmentActivity;
    await dropSnapshotsFrom(inv, opts, inv.tradeDate);
  });
}
