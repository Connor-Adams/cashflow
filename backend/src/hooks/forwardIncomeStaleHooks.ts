import type { Sequelize, Transaction } from 'sequelize';
import { Account } from '../models/Account';
import { InvestmentActivity } from '../models/InvestmentActivity';
import { SecurityDividend } from '../models/SecurityDividend';
import { HoldingSnapshot } from '../models/HoldingSnapshot';
import {
  markStaleForHousehold,
  markStaleForAllHoldersOfSecurity,
} from '../portfolio/forwardIncomeBuilder';

async function householdIdForAccount(accountId: number): Promise<number | null> {
  const acct = await Account.findByPk(accountId, { attributes: ['householdId'] });
  return acct?.householdId ?? null;
}

const ACTIVITY_TYPES_OF_INTEREST = new Set(['interest', 'buy', 'sell', 'dividend', 'transfer']);

let registered = false;

type HookOpts = { transaction?: Transaction };

function deferOrRun(opts: HookOpts | undefined, work: () => Promise<void>): void | Promise<void> {
  if (opts?.transaction) {
    opts.transaction.afterCommit(() => new Promise<void>((resolve) => setImmediate(() => work().then(resolve, resolve))));
    return;
  }
  return work();
}

export function registerForwardIncomeStaleHooks(_sequelize: Sequelize): void {
  if (registered) return;
  registered = true;

  InvestmentActivity.addHook('afterCreate', 'fwd_income_stale_inv_create', async (instance, opts) => {
    const inv = instance as InvestmentActivity;
    if (!ACTIVITY_TYPES_OF_INTEREST.has(inv.activityType)) return;
    if (inv.securityId == null) return;
    const hhId = inv.householdId ?? (await householdIdForAccount(inv.accountId));
    if (hhId == null) return;
    await deferOrRun(opts as HookOpts, () => markStaleForHousehold(hhId, inv.securityId!));
  });

  InvestmentActivity.addHook('afterUpdate', 'fwd_income_stale_inv_update', async (instance, opts) => {
    const inv = instance as InvestmentActivity;
    if (!ACTIVITY_TYPES_OF_INTEREST.has(inv.activityType)) return;
    if (inv.securityId == null) return;
    const hhId = inv.householdId ?? (await householdIdForAccount(inv.accountId));
    if (hhId == null) return;
    await deferOrRun(opts as HookOpts, () => markStaleForHousehold(hhId, inv.securityId!));
  });

  InvestmentActivity.addHook('afterDestroy', 'fwd_income_stale_inv_destroy', async (instance, opts) => {
    const inv = instance as InvestmentActivity;
    if (inv.securityId == null) return;
    const hhId = inv.householdId ?? (await householdIdForAccount(inv.accountId));
    if (hhId == null) return;
    await deferOrRun(opts as HookOpts, () => markStaleForHousehold(hhId, inv.securityId!));
  });

  SecurityDividend.addHook('afterCreate', 'fwd_income_stale_div_create', async (instance, opts) => {
    const div = instance as SecurityDividend;
    await deferOrRun(opts as HookOpts, () => markStaleForAllHoldersOfSecurity(div.securityId));
  });
  SecurityDividend.addHook('afterUpdate', 'fwd_income_stale_div_update', async (instance, opts) => {
    const div = instance as SecurityDividend;
    await deferOrRun(opts as HookOpts, () => markStaleForAllHoldersOfSecurity(div.securityId));
  });
  SecurityDividend.addHook('afterDestroy', 'fwd_income_stale_div_destroy', async (instance, opts) => {
    const div = instance as SecurityDividend;
    await deferOrRun(opts as HookOpts, () => markStaleForAllHoldersOfSecurity(div.securityId));
  });

  HoldingSnapshot.addHook('afterCreate', 'fwd_income_stale_snap_create', async (instance, opts) => {
    const snap = instance as HoldingSnapshot;
    const hhId = snap.householdId ?? (await householdIdForAccount(snap.accountId));
    if (hhId == null) return;
    await deferOrRun(opts as HookOpts, () => markStaleForHousehold(hhId, snap.securityId));
  });
}
