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
  HouseholdMember,
  Rule,
  Subscription,
  Transaction,
} from '../models';

export interface CountsResult {
  counts: Record<string, number>;
  generatedAt: string;
}

export async function getCounts(householdId: number): Promise<CountsResult> {
  const accounts = await Account.findAll({ where: { householdId }, attributes: ['id'] });
  const accountIds = accounts.map((a) => a.id);

  // ChatThread is scoped by userId; get household members first
  const members = await HouseholdMember.findAll({
    where: { householdId },
    attributes: ['userId'],
  });
  const memberUserIds = members.map((m) => m.userId);

  const [
    transactions,
    accountsCount,
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
    Transaction.count({ where: { householdId } }),
    Account.count({ where: { householdId } }),
    accountIds.length > 0
      ? HoldingSnapshot.count({ where: { accountId: { [Op.in]: accountIds } } })
      : Promise.resolve(0),
    Rule.count({ where: { householdId } }),
    Contact.count({ where: { householdId } }),
    ExternalOrder.count({ where: { householdId } }),
    Subscription.count({ where: { householdId } }),
    FinancialGoal.count({ where: { householdId } }),
    BudgetTarget.count({ where: { householdId } }),
    AuditLog.count({ where: { householdId } }),
    memberUserIds.length > 0
      ? ChatThread.count({ where: { userId: { [Op.in]: memberUserIds } } })
      : Promise.resolve(0),
    AiSuggestion.count({ where: { householdId } }),
  ]);

  return {
    counts: {
      transactions,
      accounts: accountsCount,
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
