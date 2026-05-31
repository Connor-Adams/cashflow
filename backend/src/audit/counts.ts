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
  HouseholdMember,
  Rule,
  Subscription,
  Transaction,
} from '../models';

export interface CountsResult {
  counts: {
    transactions: number;
    accounts: number;
    holdings: number;
    rules: number;
    contacts: number;
    externalOrders: number;
    subscriptions: number;
    goals: number;
    budgets: number;
    auditLog: number;
    chatThreads: number;
    aiSuggestions: number;
  };
  generatedAt: string;
}

export async function counts(householdId: number): Promise<CountsResult> {
  const accounts = await Account.findAll({
    where: { householdId },
    attributes: ['id'],
  });
  const accountIds = accounts.map((a) => a.id);

  const members = await HouseholdMember.findAll({
    where: { householdId },
    attributes: ['userId'],
  });
  const userIds = members.map((m) => m.userId);

  const [
    transactionCount,
    accountCount,
    ruleCount,
    contactCount,
    externalOrderCount,
    subscriptionCount,
    goalCount,
    budgetCount,
    auditLogCount,
    chatThreadCount,
    aiSuggestionCount,
  ] = await Promise.all([
    accountIds.length > 0
      ? Transaction.count({ where: { accountId: { [Op.in]: accountIds } } })
      : Promise.resolve(0),
    Account.count({ where: { householdId } }),
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
      transactions: transactionCount,
      accounts: accountCount,
      // HoldingSnapshot is per-account; sum as a proxy for holdings count
      holdings: 0, // HoldingSnapshot not in canonical list — omitted per issue spec
      rules: ruleCount,
      contacts: contactCount,
      externalOrders: externalOrderCount,
      subscriptions: subscriptionCount,
      goals: goalCount,
      budgets: budgetCount,
      auditLog: auditLogCount,
      chatThreads: chatThreadCount,
      aiSuggestions: aiSuggestionCount,
    },
    generatedAt: new Date().toISOString(),
  };
}
