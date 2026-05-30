import { Op } from 'sequelize';
import { Account } from '../models/Account';
import { Transaction } from '../models/Transaction';
import { HoldingSnapshot } from '../models/HoldingSnapshot';
import { Rule } from '../models/Rule';
import { Contact } from '../models/Contact';
import { ExternalOrder } from '../models/ExternalOrder';
import { Subscription } from '../models/Subscription';
import { FinancialGoal } from '../models/FinancialGoal';
import { BudgetTarget } from '../models/BudgetTarget';
import { AuditLog } from '../models/AuditLog';
import { ChatThread } from '../models/ChatThread';
import { AiSuggestion } from '../models/AiSuggestion';
import { HouseholdMember } from '../models/HouseholdMember';

export async function buildCounts(householdId: number) {
  // Get accountIds and userIds for scoped counts
  const [accounts, members] = await Promise.all([
    Account.findAll({ where: { householdId }, attributes: ['id'] }),
    HouseholdMember.findAll({ where: { householdId }, attributes: ['userId'] }),
  ]);
  const accountIds = accounts.map((a) => a.id);
  const userIds = members.map((m) => m.userId);

  const [
    transactionCount,
    accountCount,
    holdingSnapshotCount,
    ruleCount,
    contactCount,
    externalOrderCount,
    subscriptionCount,
    financialGoalCount,
    budgetTargetCount,
    auditLogCount,
    chatThreadCount,
    aiSuggestionCount,
  ] = await Promise.all([
    accountIds.length > 0
      ? Transaction.count({ where: { accountId: { [Op.in]: accountIds } } })
      : Promise.resolve(0),
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
    userIds.length > 0
      ? ChatThread.count({ where: { userId: { [Op.in]: userIds } } })
      : Promise.resolve(0),
    AiSuggestion.count({ where: { householdId } }),
  ]);

  return {
    counts: {
      transactions: transactionCount,
      accounts: accountCount,
      holdingSnapshots: holdingSnapshotCount,
      rules: ruleCount,
      contacts: contactCount,
      externalOrders: externalOrderCount,
      subscriptions: subscriptionCount,
      financialGoals: financialGoalCount,
      budgetTargets: budgetTargetCount,
      auditLog: auditLogCount,
      chatThreads: chatThreadCount,
      aiSuggestions: aiSuggestionCount,
    } as Record<string, number>,
    generatedAt: new Date().toISOString(),
  };
}
