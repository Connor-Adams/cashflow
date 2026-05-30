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

export async function counts(householdId: number) {
  // ChatThread is userId-scoped only — get member userIds
  const members = await HouseholdMember.findAll({
    where: { householdId },
    attributes: ['userId'],
  });
  const userIds = members.map((m) => m.userId);

  // Issue all counts in parallel
  const [
    transactionCount,
    accountCount,
    holdingCount,
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
    // Transaction carries householdId directly
    Transaction.count({ where: { householdId } }),
    Account.count({ where: { householdId } }),
    // HoldingSnapshot carries householdId directly
    HoldingSnapshot.count({ where: { householdId } }),
    Rule.count({ where: { householdId } }),
    Contact.count({ where: { householdId } }),
    ExternalOrder.count({ where: { householdId } }),
    Subscription.count({ where: { householdId } }),
    FinancialGoal.count({ where: { householdId } }),
    BudgetTarget.count({ where: { householdId } }),
    AuditLog.count({ where: { householdId } }),
    // ChatThread is userId-scoped, not householdId-scoped
    userIds.length > 0
      ? ChatThread.count({ where: { userId: { [Op.in]: userIds } } })
      : Promise.resolve(0),
    // AiSuggestion carries householdId directly
    AiSuggestion.count({ where: { householdId } }),
  ]);

  return {
    counts: {
      transactions: transactionCount,
      accounts: accountCount,
      holdings: holdingCount,
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
