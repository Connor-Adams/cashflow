/**
 * Re-flag historical rows on corporation-owned accounts as business, the default
 * corpBusinessDefault.ts now applies to every new and re-enriched row.
 *
 * Touches only rows with no `businessOverride` (a person's per-row choice wins)
 * whose automatic flag is not already true. Sets `autoBusiness = true` and
 * recomputes the derived columns; instance saves, so each row gets a
 * TransactionRevision.
 *
 * Refuses to run while retype-entity-flows still has rows to re-type: until it
 * has, the corp's internal moves are typed `income`, and flagging them business
 * would book them as business income in the tax reserve (prod: 60,223.83 CAD).
 */
import { Op } from 'sequelize';
import type { Transaction as DbTransaction } from 'sequelize';
import { Account, Entity, Transaction } from '../models';
import { recomputeTransactionAmounts } from './calculateShares';
import { scanEntityFlowRetypes } from './retypeEntityFlows';
import { runPlannedWrites } from './plannedWrites';

export interface CorpBusinessRow {
  id: number;
  accountId: number;
  date: string;
  amount: number;
  currency: string;
  txnType: string;
  autoBusiness: boolean | null;
}

async function corpAccountIds(t?: DbTransaction): Promise<number[]> {
  const corps = await Entity.findAll({ where: { kind: 'corp' }, attributes: ['id'], transaction: t });
  if (corps.length === 0) return [];
  const accounts = await Account.findAll({
    where: { entityId: { [Op.in]: corps.map((e) => e.id) } },
    attributes: ['id'],
    transaction: t,
  });
  return accounts.map((a) => a.id);
}

export async function scanCorpBusinessDefaults(t?: DbTransaction): Promise<CorpBusinessRow[]> {
  const accountIds = await corpAccountIds(t);
  if (accountIds.length === 0) return [];
  const rows = await Transaction.findAll({
    where: {
      accountId: { [Op.in]: accountIds },
      businessOverride: null,
      [Op.or as unknown as string]: [{ autoBusiness: false }, { autoBusiness: null }],
    },
    order: [['date', 'ASC'], ['id', 'ASC']],
    transaction: t,
  });
  return rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    date: String(r.date).slice(0, 10),
    amount: Number(r.amount),
    currency: r.currency,
    txnType: r.txnType,
    autoBusiness: r.autoBusiness ?? null,
  }));
}

export async function applyCorpBusinessDefaults(opts: { expect?: number | null } = {}): Promise<{ flagged: number }> {
  const { written } = await runPlannedWrites({
    precondition: async (t) => {
      const pending = (await scanEntityFlowRetypes(t)).length;
      return pending > 0 ? `${pending} row(s) still need scripts/retype-entity-flows.ts; run it first` : null;
    },
    plan: scanCorpBusinessDefaults,
    expect: opts.expect,
    write: async (p, t) => {
      const row = await Transaction.findByPk(p.id, { transaction: t, lock: t.LOCK.UPDATE });
      row!.set({ autoBusiness: true });
      recomputeTransactionAmounts(row!);
      await row!.save({ transaction: t });
    },
  });
  return { flagged: written };
}
