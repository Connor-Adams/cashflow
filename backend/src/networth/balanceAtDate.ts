import { Op, type WhereOptions } from 'sequelize';
import type { Account } from '../models';

export type CurrencyAmount = { currency: string; amount: number };

export async function balanceAtDate(
  account: Account,
  asOf: string
): Promise<CurrencyAmount[]> {
  if (account.closedAt && account.closedAt <= asOf) return [];

  // Lazy import to avoid circular model loading at module-init time
  const { Transaction } = await import('../models');

  const where: WhereOptions = { accountId: account.id };
  // The opening balance anchors the account at openingBalanceDate. For asOf
  // on/after the anchor, roll forward: opening + txns in (anchor, asOf].
  // For asOf BEFORE the anchor, derive backward instead: opening − txns in
  // (asOf, anchor] — otherwise every pre-anchor date would report the anchor
  // balance verbatim, ignoring known history.
  let sign = 1;
  if (account.openingBalanceDate && asOf < account.openingBalanceDate) {
    where.date = { [Op.gt]: asOf, [Op.lte]: account.openingBalanceDate };
    sign = -1;
  } else if (account.openingBalanceDate) {
    where.date = { [Op.gt]: account.openingBalanceDate, [Op.lte]: asOf };
  } else {
    where.date = { [Op.lte]: asOf };
  }

  const txns = await Transaction.findAll({
    where,
    attributes: ['currency', 'amount'],
  });

  const byCurrency = new Map<string, number>();
  for (const t of txns) {
    byCurrency.set(t.currency, (byCurrency.get(t.currency) ?? 0) + sign * Number(t.amount));
  }

  const defCcy = account.defaultCurrency ?? 'CAD';
  const opening = Number(account.openingBalance) || 0;
  byCurrency.set(defCcy, (byCurrency.get(defCcy) ?? 0) + opening);

  return Array.from(byCurrency, ([currency, amount]) => ({ currency, amount }));
}
