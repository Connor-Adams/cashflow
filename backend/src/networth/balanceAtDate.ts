import { Op, type WhereOptions } from 'sequelize';
import type { Account } from '../models';

export type CurrencyAmount = { currency: string; amount: number };

export async function balanceAtDate(
  account: Account,
  asOf: string
): Promise<CurrencyAmount[]> {
  // Lazy import to avoid circular model loading at module-init time
  const { Transaction } = await import('../models');

  const where: WhereOptions = { accountId: account.id };
  if (account.openingBalanceDate) {
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
    byCurrency.set(t.currency, (byCurrency.get(t.currency) ?? 0) + Number(t.amount));
  }

  const defCcy = account.defaultCurrency ?? 'CAD';
  const opening = Number(account.openingBalance) || 0;
  byCurrency.set(defCcy, (byCurrency.get(defCcy) ?? 0) + opening);

  return Array.from(byCurrency, ([currency, amount]) => ({ currency, amount }));
}
