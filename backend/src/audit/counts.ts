import { Op } from 'sequelize';
import {
  Account,
  AiSuggestion,
  AuditLog,
  BudgetTarget,
  ChatThread,
  Contact,
  ExternalOrder,
  FinancialGoal,
  HoldingSnapshot,
  Rule,
  Subscription,
  Transaction,
} from '../models';

export interface CountsResult {
  counts: Record<string, number>;
  generatedAt: string;
}

export async function counts(householdId: number): Promise<CountsResult> {
  const accountRows = await Account.findAll({
    where: { householdId },
    attributes: ['id'],
  });
  const accountIds = accountRows.map((a) => a.id);
  const txnWhere = accountIds.length ? { accountId: { [Op.in]: accountIds } } : { id: -1 };
  const hw = { householdId };

  const [
    transactions,
    accounts,
    holdings,
    rules,
    contacts,
    externalOrders,
    subscriptions,
    goals,
    budgets,
    auditLog,
    chatThreads,
    aiSuggestions,
  ] = await Promise.all([
    Transaction.count({ where: txnWhere }),
    Account.count({ where: hw }),
    HoldingSnapshot.count({ where: { accountId: accountIds.length ? { [Op.in]: accountIds } : -1 } }),
    Rule.count({ where: hw }),
    Contact.count({ where: hw }),
    ExternalOrder.count({ where: hw }),
    Subscription.count({ where: hw }),
    FinancialGoal.count({ where: hw }),
    BudgetTarget.count({ where: hw }),
    AuditLog.count({ where: hw }),
    ChatThread.count({ where: hw }),
    AiSuggestion.count({
      where: txnWhere,
    }),
  ]);

  return {
    counts: {
      transactions,
      accounts,
      holdings,
      rules,
      contacts,
      externalOrders,
      subscriptions,
      goals,
      budgets,
      auditLog,
      chatThreads,
      aiSuggestions,
    },
    generatedAt: new Date().toISOString(),
  };
}
