/**
 * Re-typing historical brokerage funding stored as card payments.
 *
 * `detectTypeStage` now types a bill-payment-worded narrative that names a
 * brokerage ("ONLINE BANKING PAYMENT - 4503 QUESTRADE", "MISC PAYMENT
 * QUESTRADE") as a `transfer`. Rows imported before that rule existed are still
 * `payment`. Prod at the time of writing: 7 rows on RBC Day to Day Banking
 * 6985, six contributions and one withdrawal. Four of the contributions are
 * linked to a "Contribution" on the Questrade FHSA that is already `transfer`,
 * so the two legs of one event disagree.
 *
 * The decision is delegated to the detector rather than re-implemented here, so
 * this cannot drift from the import path. It only rewrites `payment` rows whose
 * narrative matches the brokerage rule, only to `transfer`, and only on a
 * high-confidence detection.
 *
 * Every write is an instance save, so each touched row gets a
 * TransactionRevision.
 */
import type { Transaction as DbTransaction } from 'sequelize';
import { Transaction, sequelize } from '../models';
import { BROKERAGE_PAYMENT_RE } from './enrichment/detectTypeStage';
import { confidentNarrativeType, type RetypeCandidate } from './retypeCardPayments';

export function shouldRetypeAsTransfer(row: RetypeCandidate): boolean {
  if (row.txnType !== 'payment') return false;
  // Scope to the brokerage rule alone. Prod also holds `payment` rows that
  // OTHER transfer rules match ("From chequing account" on a Wealthsimple
  // account, set by the source); whether those are right is a separate call.
  if (!BROKERAGE_PAYMENT_RE.test(`${row.merchantRaw} ${row.merchantClean}`)) return false;
  return confidentNarrativeType(row) === 'transfer';
}

export interface BrokerageRetypeRow {
  id: number;
  accountId: number | null;
  date: string;
  amount: string;
  merchantRaw: string;
}

function str(v: unknown, fallback = ''): string {
  return v == null ? fallback : String(v);
}

function decide(t: Transaction): boolean {
  const merchantRaw = str(t.merchantRaw);
  return shouldRetypeAsTransfer({
    merchantRaw,
    merchantClean: str(t.merchantClean, merchantRaw),
    amount: Number(t.amount),
    txnType: t.txnType,
  });
}

export async function scanBrokerageFundingRetype(t?: DbTransaction): Promise<BrokerageRetypeRow[]> {
  const rows = await Transaction.findAll({
    attributes: ['id', 'accountId', 'date', 'amount', 'merchantRaw', 'merchantClean', 'txnType'],
    where: { txnType: 'payment' },
    order: [['id', 'ASC']],
    transaction: t,
  });
  return rows.filter(decide).map((r) => ({
    id: r.id,
    accountId: r.accountId ?? null,
    date: str(r.date).slice(0, 10),
    amount: str(r.amount),
    merchantRaw: str(r.merchantRaw),
  }));
}

/** Narrative (digit runs collapsed, so "4503 QUESTRADE" and "3970 QUESTRADE" group) × account. */
export function summarizeBrokerageRetype(
  rows: BrokerageRetypeRow[],
): Array<{ narrative: string; accountId: number | null; count: number }> {
  const groups = new Map<string, { narrative: string; accountId: number | null; count: number }>();
  for (const r of rows) {
    const narrative = r.merchantRaw.replace(/\d{3,}/g, '#');
    const key = `${r.accountId}\u0000${narrative}`;
    const g = groups.get(key) ?? { narrative, accountId: r.accountId, count: 0 };
    g.count += 1;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export class RetypeAborted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetypeAborted';
  }
}

/**
 * Re-type every candidate in one SQL transaction. The scan runs again inside the
 * transaction so the write acts on what is true at commit time; if that count is
 * not exactly `expect`, or any candidate remains after the writes, nothing is
 * committed.
 */
export async function applyBrokerageFundingRetype(opts: { expect: number }): Promise<{ retyped: number }> {
  return sequelize.transaction(async (t) => {
    const rows = await scanBrokerageFundingRetype(t);
    if (rows.length !== opts.expect) {
      throw new RetypeAborted(`expected ${opts.expect} row(s), found ${rows.length}; nothing written`);
    }
    for (const r of rows) {
      const row = await Transaction.findByPk(r.id, { transaction: t, lock: t.LOCK.UPDATE });
      if (row == null || !decide(row)) {
        throw new RetypeAborted(`transaction ${r.id} changed under the re-type; nothing written`);
      }
      row.set({ txnType: 'transfer' });
      await row.save({ transaction: t });
    }
    const after = await scanBrokerageFundingRetype(t);
    if (after.length !== 0) {
      throw new RetypeAborted(`${after.length} row(s) still typed payment after the writes; rolled back`);
    }
    return { retyped: rows.length };
  });
}
