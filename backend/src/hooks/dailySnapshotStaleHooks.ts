import type { Sequelize, Transaction } from 'sequelize';
import { Account } from '../models/Account';
import { InvestmentActivity } from '../models/InvestmentActivity';
import { markDailySnapshotsStaleForHousehold } from '../portfolio/dailySnapshotBuilder';

type HookOpts = { transaction?: Transaction };

async function householdIdForAccount(accountId: number): Promise<number | null> {
  const acct = await Account.findByPk(accountId, { attributes: ['householdId'] });
  return acct?.householdId ?? null;
}

function deferOrRun(opts: HookOpts | undefined, work: () => Promise<void>): void | Promise<void> {
  if (opts?.transaction) {
    opts.transaction.afterCommit(() => new Promise<void>((resolve) => setImmediate(() => work().then(resolve, resolve))));
    return;
  }
  return work();
}

let registered = false;

export function registerDailySnapshotStaleHooks(_sequelize: Sequelize): void {
  if (registered) return;
  registered = true;

  InvestmentActivity.addHook('afterCreate', 'daily_snapshot_stale_create', async (instance, opts) => {
    const inv = instance as InvestmentActivity;
    const hhId = inv.householdId ?? (await householdIdForAccount(inv.accountId));
    if (hhId == null) return;
    await deferOrRun(opts as HookOpts, () => markDailySnapshotsStaleForHousehold(hhId, inv.tradeDate));
  });

  InvestmentActivity.addHook('afterUpdate', 'daily_snapshot_stale_update', async (instance, opts) => {
    const inv = instance as InvestmentActivity;
    const hhId = inv.householdId ?? (await householdIdForAccount(inv.accountId));
    if (hhId == null) return;
    const newDate = inv.tradeDate;
    const prev = (inv.previous as (key: string) => string | undefined)('tradeDate');
    const fromDate = prev && prev < newDate ? prev : newDate;
    await deferOrRun(opts as HookOpts, () => markDailySnapshotsStaleForHousehold(hhId, fromDate));
  });

  InvestmentActivity.addHook('afterDestroy', 'daily_snapshot_stale_destroy', async (instance, opts) => {
    const inv = instance as InvestmentActivity;
    const hhId = inv.householdId ?? (await householdIdForAccount(inv.accountId));
    if (hhId == null) return;
    await deferOrRun(opts as HookOpts, () => markDailySnapshotsStaleForHousehold(hhId, inv.tradeDate));
  });
}
