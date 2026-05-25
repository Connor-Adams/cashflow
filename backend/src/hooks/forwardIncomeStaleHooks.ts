import type { Sequelize } from 'sequelize';
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

export function registerForwardIncomeStaleHooks(_sequelize: Sequelize): void {
  if (registered) return;
  registered = true;
  InvestmentActivity.addHook('afterCreate', 'fwd_income_stale_inv_create', async (instance) => {
    if (!ACTIVITY_TYPES_OF_INTEREST.has(instance.activityType)) return;
    if (instance.securityId == null) return;
    const hhId = instance.householdId ?? (await householdIdForAccount(instance.accountId));
    if (hhId == null) return;
    await markStaleForHousehold(hhId, instance.securityId);
  });

  InvestmentActivity.addHook('afterUpdate', 'fwd_income_stale_inv_update', async (instance) => {
    if (!ACTIVITY_TYPES_OF_INTEREST.has(instance.activityType)) return;
    if (instance.securityId == null) return;
    const hhId = instance.householdId ?? (await householdIdForAccount(instance.accountId));
    if (hhId == null) return;
    await markStaleForHousehold(hhId, instance.securityId);
  });

  InvestmentActivity.addHook('afterDestroy', 'fwd_income_stale_inv_destroy', async (instance) => {
    if (instance.securityId == null) return;
    const hhId = instance.householdId ?? (await householdIdForAccount(instance.accountId));
    if (hhId == null) return;
    await markStaleForHousehold(hhId, instance.securityId);
  });

  SecurityDividend.addHook('afterCreate', 'fwd_income_stale_div_create', async (instance) => {
    await markStaleForAllHoldersOfSecurity(instance.securityId);
  });
  SecurityDividend.addHook('afterUpdate', 'fwd_income_stale_div_update', async (instance) => {
    await markStaleForAllHoldersOfSecurity(instance.securityId);
  });
  SecurityDividend.addHook('afterDestroy', 'fwd_income_stale_div_destroy', async (instance) => {
    await markStaleForAllHoldersOfSecurity(instance.securityId);
  });

  HoldingSnapshot.addHook('afterCreate', 'fwd_income_stale_snap_create', async (instance) => {
    const hhId = instance.householdId ?? (await householdIdForAccount(instance.accountId));
    if (hhId == null) return;
    await markStaleForHousehold(hhId, instance.securityId);
  });
}
