import type { Sequelize } from 'sequelize';
import { InvestmentActivity } from '../models/InvestmentActivity';
import { SecurityDividend } from '../models/SecurityDividend';
import { HoldingSnapshot } from '../models/HoldingSnapshot';
import {
  markStaleForHousehold,
  markStaleForAllHoldersOfSecurity,
} from '../portfolio/forwardIncomeBuilder';
import { hookTransaction, householdIdForRow } from './hookTransaction';

// Every stale-mark runs in the hooked write's own transaction — see
// hookTransaction.ts for why it is not deferred to afterCommit.

const ACTIVITY_TYPES_OF_INTEREST = new Set(['interest', 'buy', 'sell', 'dividend', 'transfer']);

/** Mark the household's projection for `row.securityId` stale. */
async function markRowSecurityStale(
  row: { householdId: number | null; accountId: number; securityId: number | null },
  opts: unknown,
): Promise<void> {
  if (row.securityId == null) return;
  const t = hookTransaction(opts);
  const hhId = await householdIdForRow(row, t);
  if (hhId == null) return;
  await markStaleForHousehold(hhId, row.securityId, t);
}

let registered = false;

export function registerForwardIncomeStaleHooks(_sequelize: Sequelize): void {
  if (registered) return;
  registered = true;

  InvestmentActivity.addHook('afterCreate', 'fwd_income_stale_inv_create', async (instance, opts) => {
    const inv = instance as InvestmentActivity;
    if (!ACTIVITY_TYPES_OF_INTEREST.has(inv.activityType)) return;
    await markRowSecurityStale(inv, opts);
  });

  InvestmentActivity.addHook('afterUpdate', 'fwd_income_stale_inv_update', async (instance, opts) => {
    const inv = instance as InvestmentActivity;
    if (!ACTIVITY_TYPES_OF_INTEREST.has(inv.activityType)) return;
    await markRowSecurityStale(inv, opts);
  });

  InvestmentActivity.addHook('afterDestroy', 'fwd_income_stale_inv_destroy', async (instance, opts) => {
    await markRowSecurityStale(instance as InvestmentActivity, opts);
  });

  SecurityDividend.addHook('afterCreate', 'fwd_income_stale_div_create', async (instance, opts) => {
    const div = instance as SecurityDividend;
    await markStaleForAllHoldersOfSecurity(div.securityId, hookTransaction(opts));
  });
  SecurityDividend.addHook('afterUpdate', 'fwd_income_stale_div_update', async (instance, opts) => {
    const div = instance as SecurityDividend;
    await markStaleForAllHoldersOfSecurity(div.securityId, hookTransaction(opts));
  });
  SecurityDividend.addHook('afterDestroy', 'fwd_income_stale_div_destroy', async (instance, opts) => {
    const div = instance as SecurityDividend;
    await markStaleForAllHoldersOfSecurity(div.securityId, hookTransaction(opts));
  });

  HoldingSnapshot.addHook('afterCreate', 'fwd_income_stale_snap_create', async (instance, opts) => {
    await markRowSecurityStale(instance as HoldingSnapshot, opts);
  });
}
