/**
 * Re-type historical rows the entity rules in detectTypeStage now decide:
 *
 *   income → transfer   an inflow onto a company account from that same company
 *                       ("Direct deposit from CDG LABS INC" into the corp's own
 *                       Wealthsimple chequing). The nightly job had flipped these
 *                       to income because the payer was not an owner NAME.
 *   transfer/unknown → income
 *                       a client paying the company on Wise ("Received money
 *                       from WANDERCOM"), which the generic "received money from"
 *                       transfer rule claimed.
 *
 * The decision is entityFlowType's, the same function imports and the nightly
 * backfill run, so this cannot drift from them. Nothing else is rewritten: only
 * those two transitions, only on rows the entity rules actually fire for.
 * Every write is an instance save, so each row gets a TransactionRevision.
 */
import { Op } from 'sequelize';
import { Account, Transaction } from '../models';
import { entityFlowType } from './enrichment/detectTypeStage';
import { loadAccountEntityContext, loadHouseholdOwnerNames } from './enrichment/loaders';
import { runPlannedWrites } from './plannedWrites';

export interface EntityFlowRetype {
  id: number;
  householdId: number | null;
  accountId: number;
  date: string;
  amount: number;
  from: string;
  to: 'transfer' | 'income';
}

/** The new type for a row, or null to leave it. Exported for tests. */
export function retypeTarget(
  current: string | null,
  decided: 'transfer' | 'income' | null,
): 'transfer' | 'income' | null {
  if (decided === 'transfer' && current === 'income') return 'transfer';
  if (decided === 'income' && (current === 'transfer' || current === 'unknown')) return 'income';
  return null;
}

/** Inflows on accounts owned by a company entity, with the type each should carry. */
export async function scanEntityFlowRetypes(
  t?: import('sequelize').Transaction,
): Promise<EntityFlowRetype[]> {
  const accounts = await Account.findAll({
    where: { entityId: { [Op.ne]: null } },
    attributes: ['id', 'householdId'],
    transaction: t,
  });
  const out: EntityFlowRetype[] = [];
  const ownersByHousehold = new Map<number | null, string[]>();
  for (const account of accounts) {
    const entity = await loadAccountEntityContext(account.id, account.householdId ?? null);
    if (entity?.kind !== 'corp') continue;
    const hh = account.householdId ?? null;
    if (!ownersByHousehold.has(hh)) ownersByHousehold.set(hh, await loadHouseholdOwnerNames(hh));
    const ownerNames = ownersByHousehold.get(hh)!;
    const rows = await Transaction.findAll({
      where: { accountId: account.id, amount: { [Op.gt]: 0 } },
      order: [['date', 'ASC'], ['id', 'ASC']],
      transaction: t,
    });
    for (const r of rows) {
      const decided = entityFlowType({
        merchantRaw: r.merchantRaw,
        merchantClean: r.merchantClean ?? r.merchantRaw,
        amount: Number(r.amount),
        ownerNames,
        accountEntity: entity,
      });
      const to = retypeTarget(r.txnType, decided);
      if (to == null) continue;
      out.push({
        id: r.id,
        householdId: r.householdId,
        accountId: r.accountId,
        date: String(r.date).slice(0, 10),
        amount: Number(r.amount),
        from: r.txnType,
        to,
      });
    }
  }
  return out;
}

/**
 * Apply every re-type in one SQL transaction. Re-scans inside it; aborts on an
 * `expect` mismatch and rolls back unless nothing is left to re-type.
 */
export async function applyEntityFlowRetypes(opts: { expect?: number | null } = {}): Promise<{ retyped: number }> {
  const { written } = await runPlannedWrites({
    plan: scanEntityFlowRetypes,
    expect: opts.expect,
    write: async (p, t) => {
      const row = await Transaction.findByPk(p.id, { transaction: t, lock: t.LOCK.UPDATE });
      row!.set({ txnType: p.to });
      await row!.save({ transaction: t });
    },
  });
  return { retyped: written };
}
