import { Op } from 'sequelize';
import { Transaction } from '../models';
import { num } from '../util/numbers';

export async function pendingTotal(args: {
  accountId: number;
  householdId: number | null;
  asOf?: string | null;
}): Promise<{ total: number; count: number }> {
  const where: Record<string, unknown> = {
    accountId: args.accountId,
    householdId: args.householdId,
    status: 'pending',
  };
  if (args.asOf) {
    where.date = { [Op.lte]: args.asOf };
  }
  const [sum, count] = await Promise.all([
    Transaction.sum('amount', { where }),
    Transaction.count({ where }),
  ]);
  return {
    total: num(sum ?? 0) ?? 0,
    count,
  };
}
