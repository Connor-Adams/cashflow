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

export type CountsResult = {
  counts: Record<string, number>;
  generatedAt: string;
};

export async function runCounts(householdId: number): Promise<CountsResult> {
  // ChatThread scopes by userId — fetch member userIds first.
  const members = await HouseholdMember.findAll({ where: { householdId } });
  const userIds = members.map((m) => m.userId);

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
    auditLogCount,
    chatThreads,
    aiSuggestions,
  ] = await Promise.all([
    Transaction.count({ where: { householdId } }),
    Account.count({ where: { householdId } }),
    HoldingSnapshot.count({ where: { householdId } }),
    Rule.count({ where: { householdId } }),
    Contact.count({ where: { householdId } }),
    ExternalOrder.count({ where: { householdId } }),
    Subscription.count({ where: { householdId } }),
    FinancialGoal.count({ where: { householdId } }),
    BudgetTarget.count({ where: { householdId } }),
    AuditLog.count({ where: { householdId } }),
    userIds.length > 0
      ? ChatThread.count({ where: { userId: { [Op.in]: userIds } } })
      : Promise.resolve(0),
    AiSuggestion.count({ where: { householdId } }),
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
      auditLog: auditLogCount,
      chatThreads,
      aiSuggestions,
    },
    generatedAt: new Date().toISOString(),
  };
}
