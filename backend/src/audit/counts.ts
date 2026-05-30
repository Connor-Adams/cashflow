import {
  Transaction,
  Account,
  HoldingSnapshot,
  Rule,
  Contact,
  ExternalOrder,
  Subscription,
  FinancialGoal,
  BudgetTarget,
  AuditLog,
  ChatThread,
  AiSuggestion,
  HouseholdMember,
} from '../models';
import { Op } from 'sequelize';

export type AuditCounts = {
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

export async function buildCounts(householdId: number): Promise<AuditCounts> {
  // Transaction is scoped via accountId IN householdAccountIds
  const accountIds = (
    await Account.findAll({
      where: { householdId },
      attributes: ['id'],
    })
  ).map((a) => a.id);

  // ChatThread and AiSuggestion may scope by userId; get household userIds
  const memberUserIds = (
    await HouseholdMember.findAll({
      where: { householdId },
      attributes: ['userId'],
    })
  ).map((m) => m.userId);

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
    accountIds.length > 0
      ? Transaction.count({ where: { accountId: { [Op.in]: accountIds } } })
      : Promise.resolve(0),
    Account.count({ where: { householdId } }),
    HoldingSnapshot.count({ where: { householdId } }),
    Rule.count({ where: { householdId } }),
    Contact.count({ where: { householdId } }),
    ExternalOrder.count({ where: { householdId } }),
    Subscription.count({ where: { householdId } }),
    FinancialGoal.count({ where: { householdId } }),
    BudgetTarget.count({ where: { householdId } }),
    AuditLog.count({ where: { householdId } }),
    // ChatThread scopes by userId only (no householdId field on the model)
    memberUserIds.length > 0
      ? ChatThread.count({ where: { userId: { [Op.in]: memberUserIds } } })
      : Promise.resolve(0),
    AiSuggestion.count({ where: { householdId } }),
  ]);

  return {
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
  };
}
