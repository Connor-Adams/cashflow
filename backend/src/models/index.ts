import { sequelize } from '../db';
import { Account, initAccount } from './Account';
import { Rule, initRule } from './Rule';
import { Transaction, initTransaction } from './Transaction';
import { ImportHistory, initImportHistory } from './ImportHistory';
import { Receipt, initReceipt } from './Receipt';
import { User, initUser } from './User';
import { Session, initSession } from './Session';
import { Household, initHousehold } from './Household';
import { HouseholdMember, initHouseholdMember } from './HouseholdMember';
import { HouseholdInvite, initHouseholdInvite } from './HouseholdInvite';
import { Contact, initContact } from './Contact';
import { Category, initCategory } from './Category';
import { PartnerSettlement, initPartnerSettlement } from './PartnerSettlement';
import { BudgetTarget, initBudgetTarget } from './BudgetTarget';
import { BudgetExclusion, initBudgetExclusion } from './BudgetExclusion';
import { AiSuggestion, initAiSuggestion } from './AiSuggestion';
import { ChatThread, initChatThread } from './ChatThread';
import { ChatMessage, initChatMessage } from './ChatMessage';
import { ChatProposal, initChatProposal } from './ChatProposal';
import { ExternalOrder, initExternalOrder } from './ExternalOrder';
import { ExternalOrderItem, initExternalOrderItem } from './ExternalOrderItem';
import { ExternalOrderTender, initExternalOrderTender } from './ExternalOrderTender';
import { TransactionOrderLink, initTransactionOrderLink } from './TransactionOrderLink';
import { TransactionSignal, initTransactionSignal } from './TransactionSignal';
import { TransactionRevision, initTransactionRevision } from './TransactionRevision';
import { Security, initSecurity } from './Security';
import { InvestmentActivity, initInvestmentActivity } from './InvestmentActivity';
import { HoldingSnapshot, initHoldingSnapshot } from './HoldingSnapshot';
import { SecurityPrice, initSecurityPrice } from './SecurityPrice';
import { SecurityDailyPrice, initSecurityDailyPrice } from './SecurityDailyPrice';
import { SecurityDividend, initSecurityDividend } from './SecurityDividend';
import { FxRate, initFxRate } from './FxRate';
import { UserEmailIntegration, initUserEmailIntegration } from './UserEmailIntegration';
import { ReceiptSenderAllowlist, initReceiptSenderAllowlist } from './ReceiptSenderAllowlist';
import { ProcessedEmailMessage, initProcessedEmailMessage } from './ProcessedEmailMessage';
import { UserCaptureToken, initUserCaptureToken } from './UserCaptureToken';
import { Entity, initEntity } from './Entity';
import { TaxCategory, initTaxCategory } from './TaxCategory';
import { TaxTag, initTaxTag } from './TaxTag';
import { TransactionTaxMetadata, initTransactionTaxMetadata } from './TransactionTaxMetadata';
import {
  TransactionReturnMetadata,
  initTransactionReturnMetadata,
} from './TransactionReturnMetadata';
import { TaxSlip, initTaxSlip } from './TaxSlip';
import { Carryforward, initCarryforward } from './Carryforward';
import { TaxReturn, initTaxReturn } from './TaxReturn';
import { ShareholderLoan, initShareholderLoan } from './ShareholderLoan';
import { InstalmentPayment, initInstalmentPayment } from './InstalmentPayment';
import { ProviderJobLog, initProviderJobLog } from './ProviderJobLog';
import { Job, initJob } from './Job';
import {
  PortfolioForwardProjection,
  initPortfolioForwardProjection,
} from './PortfolioForwardProjection';
import {
  PortfolioDailySnapshot,
  initPortfolioDailySnapshot,
} from './PortfolioDailySnapshot';
import { registerForwardIncomeStaleHooks } from '../hooks/forwardIncomeStaleHooks';
import { registerDailySnapshotStaleHooks } from '../hooks/dailySnapshotStaleHooks';
import { Scenario, initScenario } from './Scenario';
import { ScenarioReturn, initScenarioReturn } from './ScenarioReturn';
import { HouseholdPlan, initHouseholdPlan } from './HouseholdPlan';
import { Insight, initInsight } from './Insight';
import { PlannedEvent, initPlannedEvent } from './PlannedEvent';
import { FinancialGoal, initFinancialGoal } from './FinancialGoal';
import { Subscription, initSubscription } from './Subscription';
import { AiReviewRun, initAiReviewRun } from './AiReviewRun';
import { CashflowSettings, initCashflowSettings } from './CashflowSettings';
import {
  MoneyLeakDismissal,
  initMoneyLeakDismissal,
} from './MoneyLeakDismissal';
import { TaxReserveSetting, initTaxReserveSetting } from './TaxReserveSetting';
import {
  MonthlyClosePeriod,
  initMonthlyClosePeriod,
} from './MonthlyClosePeriod';
import { MonthlyCloseTask, initMonthlyCloseTask } from './MonthlyCloseTask';
import { Purchase, initPurchase } from './Purchase';
import { Notification, initNotification } from './Notification';
import {
  NotificationPreference,
  initNotificationPreference,
} from './NotificationPreference';
import { BudgetAlertState, initBudgetAlertState } from './BudgetAlertState';

initUser(sequelize);
initSession(sequelize);
initHousehold(sequelize);
initHouseholdMember(sequelize);
initHouseholdInvite(sequelize);
initContact(sequelize);
initCategory(sequelize);
initPartnerSettlement(sequelize);
initBudgetTarget(sequelize);
initBudgetExclusion(sequelize);
initAccount(sequelize);
initRule(sequelize);
initTransaction(sequelize);
initImportHistory(sequelize);
initReceipt(sequelize);
initAiSuggestion(sequelize);
initChatThread(sequelize);
initChatMessage(sequelize);
initChatProposal(sequelize);
initExternalOrder(sequelize);
initExternalOrderItem(sequelize);
initExternalOrderTender(sequelize);
initTransactionOrderLink(sequelize);
initTransactionSignal(sequelize);
initTransactionRevision(sequelize);
initSecurity(sequelize);
initInvestmentActivity(sequelize);
initHoldingSnapshot(sequelize);
initSecurityPrice(sequelize);
initSecurityDailyPrice(sequelize);
initSecurityDividend(sequelize);
initFxRate(sequelize);
initUserEmailIntegration(sequelize);
initReceiptSenderAllowlist(sequelize);
initProcessedEmailMessage(sequelize);
initUserCaptureToken(sequelize);
initEntity(sequelize);
initTaxCategory(sequelize);
initTaxTag(sequelize);
initTransactionTaxMetadata(sequelize);
initTransactionReturnMetadata(sequelize);
initTaxSlip(sequelize);
initCarryforward(sequelize);
initTaxReturn(sequelize);
initShareholderLoan(sequelize);
initInstalmentPayment(sequelize);
initProviderJobLog(sequelize);
initJob(sequelize);
initPortfolioForwardProjection(sequelize);
initPortfolioDailySnapshot(sequelize);
registerForwardIncomeStaleHooks(sequelize);
registerDailySnapshotStaleHooks(sequelize);
initScenario(sequelize);
initScenarioReturn(sequelize);
initHouseholdPlan(sequelize);
initInsight(sequelize);
initPlannedEvent(sequelize);
initFinancialGoal(sequelize);
initSubscription(sequelize);
initAiReviewRun(sequelize);
initMoneyLeakDismissal(sequelize);
initTaxReserveSetting(sequelize);
initMonthlyClosePeriod(sequelize);
initMonthlyCloseTask(sequelize);
initPurchase(sequelize);
initCashflowSettings(sequelize);
initNotification(sequelize);
initNotificationPreference(sequelize);
initBudgetAlertState(sequelize);

User.hasMany(Notification, {
  foreignKey: 'user_id',
  as: 'notifications',
  onDelete: 'CASCADE',
  hooks: true,
});
Notification.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
User.hasMany(NotificationPreference, {
  foreignKey: 'user_id',
  as: 'notificationPreferences',
  onDelete: 'CASCADE',
  hooks: true,
});
NotificationPreference.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

Household.hasMany(Entity, { foreignKey: 'household_id', as: 'taxEntities' });
Entity.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });
Entity.belongsTo(Entity, { foreignKey: 'spouseEntityId', as: 'spouse' });

Household.hasMany(TaxTag, { foreignKey: 'household_id', as: 'taxTags' });
TaxTag.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });

Transaction.hasOne(TransactionTaxMetadata, {
  foreignKey: 'transaction_id',
  as: 'taxMetadata',
  onDelete: 'CASCADE',
  hooks: true,
});
TransactionTaxMetadata.belongsTo(Transaction, {
  foreignKey: 'transaction_id',
  as: 'transaction',
});

Transaction.hasOne(TransactionReturnMetadata, {
  foreignKey: 'transaction_id',
  as: 'returnMetadata',
  onDelete: 'CASCADE',
  hooks: true,
});
TransactionReturnMetadata.belongsTo(Transaction, {
  foreignKey: 'transaction_id',
  as: 'transaction',
});
TaxTag.hasMany(TransactionTaxMetadata, {
  foreignKey: 'tax_tag_id',
  as: 'transactionTaxMetadata',
});
TransactionTaxMetadata.belongsTo(TaxTag, {
  foreignKey: 'tax_tag_id',
  as: 'taxTag',
});

Household.hasMany(ProcessedEmailMessage, {
  foreignKey: 'household_id',
  as: 'processedEmailMessages',
});
ProcessedEmailMessage.belongsTo(Household, {
  foreignKey: 'household_id',
  as: 'household',
});

Household.hasMany(ReceiptSenderAllowlist, {
  foreignKey: 'household_id',
  as: 'receiptSenderAllowlist',
});
ReceiptSenderAllowlist.belongsTo(Household, {
  foreignKey: 'household_id',
  as: 'household',
});

User.hasMany(UserEmailIntegration, {
  foreignKey: 'user_id',
  as: 'emailIntegrations',
});
UserEmailIntegration.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

Account.hasMany(Transaction, { foreignKey: 'account_id', as: 'transactions' });
Transaction.belongsTo(Account, { foreignKey: 'account_id', as: 'account' });
Account.hasMany(InvestmentActivity, {
  foreignKey: 'account_id',
  as: 'investmentActivities',
});
InvestmentActivity.belongsTo(Account, { foreignKey: 'account_id', as: 'account' });
Account.hasMany(HoldingSnapshot, { foreignKey: 'account_id', as: 'holdings' });
HoldingSnapshot.belongsTo(Account, { foreignKey: 'account_id', as: 'account' });
Security.hasMany(InvestmentActivity, {
  foreignKey: 'security_id',
  as: 'activities',
});
InvestmentActivity.belongsTo(Security, { foreignKey: 'security_id', as: 'security' });
Security.hasMany(HoldingSnapshot, { foreignKey: 'security_id', as: 'holdings' });
HoldingSnapshot.belongsTo(Security, { foreignKey: 'security_id', as: 'security' });
Security.hasMany(SecurityPrice, { foreignKey: 'security_id', as: 'prices' });
SecurityPrice.belongsTo(Security, { foreignKey: 'security_id', as: 'security' });
Security.hasMany(SecurityDailyPrice, {
  foreignKey: 'security_id',
  as: 'dailyPrices',
});
SecurityDailyPrice.belongsTo(Security, {
  foreignKey: 'security_id',
  as: 'security',
});
Security.hasMany(SecurityDividend, {
  foreignKey: 'security_id',
  as: 'dividends',
});
SecurityDividend.belongsTo(Security, {
  foreignKey: 'security_id',
  as: 'security',
});
User.hasMany(Session, { foreignKey: 'user_id', as: 'sessions' });
Session.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
Household.hasMany(HouseholdMember, { foreignKey: 'household_id', as: 'members' });
HouseholdMember.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });
HouseholdMember.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
Household.hasMany(Contact, { foreignKey: 'household_id', as: 'contacts' });
Contact.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });
Household.hasMany(Category, { foreignKey: 'household_id', as: 'categories' });
Category.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });
Transaction.belongsTo(Contact, { foreignKey: 'ownership_contact_id', as: 'ownershipContact' });
Household.hasMany(PartnerSettlement, {
  foreignKey: 'household_id',
  as: 'partnerSettlements',
});
PartnerSettlement.belongsTo(Household, {
  foreignKey: 'household_id',
  as: 'household',
});
Contact.hasMany(PartnerSettlement, {
  foreignKey: 'contact_id',
  as: 'partnerSettlements',
});
PartnerSettlement.belongsTo(Contact, { foreignKey: 'contact_id', as: 'contact' });
Household.hasMany(BudgetTarget, {
  foreignKey: 'household_id',
  as: 'budgetTargets',
});
BudgetTarget.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });
BudgetTarget.hasMany(BudgetExclusion, {
  foreignKey: 'budget_id',
  as: 'exclusions',
  onDelete: 'CASCADE',
  hooks: true,
});
// Cascade alert-state cleanup when a budget is deleted (issue #268, AC #12).
// Without this association the migration's FK ON DELETE CASCADE still fires
// at the DB level, but exposing it on the ORM means future eager-loads
// (e.g. `include: [{ model: BudgetAlertState }]`) work without ad-hoc joins.
BudgetTarget.hasMany(BudgetAlertState, {
  foreignKey: 'budget_target_id',
  as: 'alertStates',
  onDelete: 'CASCADE',
  hooks: true,
});
BudgetAlertState.belongsTo(BudgetTarget, {
  foreignKey: 'budget_target_id',
  as: 'budget',
});
User.hasMany(BudgetAlertState, {
  foreignKey: 'user_id',
  as: 'budgetAlertStates',
  onDelete: 'CASCADE',
  hooks: true,
});
BudgetAlertState.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
BudgetExclusion.belongsTo(BudgetTarget, {
  foreignKey: 'budget_id',
  as: 'budget',
});
BudgetExclusion.belongsTo(Transaction, {
  foreignKey: 'transaction_id',
  as: 'transaction',
});
Rule.hasMany(Transaction, {
  foreignKey: 'applied_rule_id',
  as: 'appliedTransactions',
});
Transaction.belongsTo(Rule, { foreignKey: 'applied_rule_id', as: 'appliedRule' });
Transaction.hasMany(Receipt, { foreignKey: 'transaction_id', as: 'receipts' });
Receipt.belongsTo(Transaction, { foreignKey: 'transaction_id', as: 'transaction' });
Receipt.belongsTo(ExternalOrder, {
  as: 'externalOrder',
  foreignKey: 'externalOrderId',
});
ExternalOrder.hasMany(Receipt, {
  as: 'receipts',
  foreignKey: 'externalOrderId',
});
Transaction.hasMany(AiSuggestion, {
  foreignKey: 'transaction_id',
  as: 'aiSuggestions',
});
AiSuggestion.belongsTo(Transaction, {
  foreignKey: 'transaction_id',
  as: 'transaction',
});
Receipt.hasMany(AiSuggestion, { foreignKey: 'receipt_id', as: 'aiSuggestions' });
AiSuggestion.belongsTo(Receipt, { foreignKey: 'receipt_id', as: 'receipt' });
ExternalOrder.hasMany(ExternalOrderItem, {
  foreignKey: 'external_order_id',
  as: 'items',
});
ExternalOrderItem.belongsTo(ExternalOrder, {
  foreignKey: 'external_order_id',
  as: 'order',
});
ExternalOrder.hasMany(ExternalOrderTender, {
  foreignKey: 'external_order_id',
  as: 'tenders',
});
ExternalOrderTender.belongsTo(ExternalOrder, {
  foreignKey: 'external_order_id',
  as: 'order',
});
Transaction.hasMany(TransactionOrderLink, {
  foreignKey: 'transaction_id',
  as: 'orderLinks',
});
TransactionOrderLink.belongsTo(Transaction, {
  foreignKey: 'transaction_id',
  as: 'transaction',
});
ExternalOrder.hasMany(TransactionOrderLink, {
  foreignKey: 'external_order_id',
  as: 'transactionLinks',
});
TransactionOrderLink.belongsTo(ExternalOrder, {
  foreignKey: 'external_order_id',
  as: 'order',
});
Transaction.hasMany(TransactionSignal, {
  foreignKey: 'transaction_id',
  as: 'enrichmentSignals',
});
TransactionSignal.belongsTo(Transaction, {
  foreignKey: 'transaction_id',
  as: 'transaction',
});

Transaction.hasMany(TransactionRevision, {
  foreignKey: 'transaction_id',
  as: 'revisions',
  onDelete: 'CASCADE',
  hooks: true,
});
TransactionRevision.belongsTo(Transaction, {
  foreignKey: 'transaction_id',
  as: 'transaction',
});

Scenario.hasMany(ScenarioReturn, {
  foreignKey: 'scenario_id',
  as: 'returns',
  onDelete: 'CASCADE',
  hooks: true,
});
ScenarioReturn.belongsTo(Scenario, {
  foreignKey: 'scenario_id',
  as: 'scenario',
});

Household.hasMany(HouseholdPlan, {
  foreignKey: 'household_id',
  as: 'householdPlans',
  onDelete: 'CASCADE',
  hooks: true,
});
HouseholdPlan.belongsTo(Household, {
  foreignKey: 'household_id',
  as: 'household',
});

Scenario.belongsTo(HouseholdPlan, {
  foreignKey: 'householdPlanId',
  as: 'householdPlan',
});
HouseholdPlan.hasMany(Scenario, {
  foreignKey: 'householdPlanId',
  as: 'scenarios',
});

Household.hasMany(PlannedEvent, {
  foreignKey: 'household_id',
  as: 'plannedEvents',
  onDelete: 'CASCADE',
  hooks: true,
});
PlannedEvent.belongsTo(Household, {
  foreignKey: 'household_id',
  as: 'household',
});
User.hasMany(PlannedEvent, {
  foreignKey: 'user_id',
  as: 'plannedEvents',
});
PlannedEvent.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'user',
});
Account.hasMany(PlannedEvent, {
  foreignKey: 'account_id',
  as: 'plannedEvents',
});
PlannedEvent.belongsTo(Account, {
  foreignKey: 'account_id',
  as: 'account',
});
Transaction.hasMany(PlannedEvent, {
  foreignKey: 'linked_transaction_id',
  as: 'plannedEvents',
});
PlannedEvent.belongsTo(Transaction, {
  foreignKey: 'linked_transaction_id',
  as: 'linkedTransaction',
});

Household.hasMany(FinancialGoal, {
  foreignKey: 'household_id',
  as: 'financialGoals',
  onDelete: 'CASCADE',
  hooks: true,
});
FinancialGoal.belongsTo(Household, {
  foreignKey: 'household_id',
  as: 'household',
});
User.hasMany(FinancialGoal, {
  foreignKey: 'user_id',
  as: 'financialGoals',
});
FinancialGoal.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'user',
});
Account.hasMany(FinancialGoal, {
  foreignKey: 'linked_account_id',
  as: 'financialGoals',
});
FinancialGoal.belongsTo(Account, {
  foreignKey: 'linked_account_id',
  as: 'linkedAccount',
});

Household.hasMany(Subscription, {
  foreignKey: 'household_id',
  as: 'subscriptions',
  onDelete: 'CASCADE',
  hooks: true,
});
Subscription.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });

Household.hasMany(MoneyLeakDismissal, {
  foreignKey: 'household_id',
  as: 'moneyLeakDismissals',
  onDelete: 'CASCADE',
  hooks: true,
});
MoneyLeakDismissal.belongsTo(Household, {
  foreignKey: 'household_id',
  as: 'household',
});
User.hasMany(MoneyLeakDismissal, {
  foreignKey: 'dismissed_by_user_id',
  as: 'moneyLeakDismissals',
});
MoneyLeakDismissal.belongsTo(User, {
  foreignKey: 'dismissed_by_user_id',
  as: 'dismissedByUser',
});

Household.hasMany(AiReviewRun, {
  foreignKey: 'household_id',
  as: 'aiReviewRuns',
  onDelete: 'CASCADE',
  hooks: true,
});
AiReviewRun.belongsTo(Household, {
  foreignKey: 'household_id',
  as: 'household',
});
User.hasMany(AiReviewRun, {
  foreignKey: 'user_id',
  as: 'aiReviewRuns',
});
AiReviewRun.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'user',
});

Household.hasMany(TaxReserveSetting, {
  foreignKey: 'household_id',
  as: 'taxReserveSettings',
  onDelete: 'CASCADE',
  hooks: true,
});
TaxReserveSetting.belongsTo(Household, {
  foreignKey: 'household_id',
  as: 'household',
});

// Monthly close (issue #227). Period cascades to tasks; deleting a
// household removes its periods and (via the period→task cascade) tasks.
Household.hasMany(MonthlyClosePeriod, {
  foreignKey: 'household_id',
  as: 'monthlyClosePeriods',
  onDelete: 'CASCADE',
  hooks: true,
});
MonthlyClosePeriod.belongsTo(Household, {
  foreignKey: 'household_id',
  as: 'household',
});
User.hasMany(MonthlyClosePeriod, {
  foreignKey: 'user_id',
  as: 'monthlyClosePeriods',
});
MonthlyClosePeriod.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'user',
});
MonthlyClosePeriod.hasMany(MonthlyCloseTask, {
  foreignKey: 'period_id',
  as: 'tasks',
  onDelete: 'CASCADE',
  hooks: true,
});
MonthlyCloseTask.belongsTo(MonthlyClosePeriod, {
  foreignKey: 'period_id',
  as: 'period',
});
MonthlyCloseTask.belongsTo(User, {
  foreignKey: 'completed_by_user_id',
  as: 'completedByUser',
});

Transaction.hasOne(Purchase, {
  foreignKey: 'transaction_id',
  as: 'purchase',
  onDelete: 'CASCADE',
  hooks: true,
});
Purchase.belongsTo(Transaction, {
  foreignKey: 'transaction_id',
  as: 'transaction',
});
Household.hasMany(Purchase, {
  foreignKey: 'household_id',
  as: 'purchases',
});
Purchase.belongsTo(Household, {
  foreignKey: 'household_id',
  as: 'household',
});
User.hasMany(Purchase, {
  foreignKey: 'marked_by_user_id',
  as: 'markedPurchases',
});
Purchase.belongsTo(User, {
  foreignKey: 'marked_by_user_id',
  as: 'markedByUser',
});

// CashflowSettings is a singleton per user (issue #199). UNIQUE(user_id) at
// the DB level; we surface the relationship as hasOne so callers can eager
// load via `include: [{ model: CashflowSettings, as: 'cashflowSettings' }]`.
User.hasOne(CashflowSettings, {
  foreignKey: 'user_id',
  as: 'cashflowSettings',
  onDelete: 'CASCADE',
});
CashflowSettings.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'user',
});

export {
  sequelize,
  User,
  Session,
  Household,
  HouseholdMember,
  HouseholdInvite,
  Contact,
  Category,
  PartnerSettlement,
  BudgetTarget,
  BudgetExclusion,
  Account,
  Rule,
  Transaction,
  ImportHistory,
  Receipt,
  AiSuggestion,
  ChatThread,
  ChatMessage,
  ChatProposal,
  ExternalOrder,
  ExternalOrderItem,
  ExternalOrderTender,
  TransactionOrderLink,
  TransactionSignal,
  TransactionRevision,
  Security,
  InvestmentActivity,
  HoldingSnapshot,
  SecurityPrice,
  SecurityDailyPrice,
  SecurityDividend,
  FxRate,
  UserEmailIntegration,
  ReceiptSenderAllowlist,
  ProcessedEmailMessage,
  UserCaptureToken,
  Entity,
  TaxCategory,
  TaxTag,
  TransactionTaxMetadata,
  TransactionReturnMetadata,
  TaxSlip,
  Carryforward,
  TaxReturn,
  ShareholderLoan,
  InstalmentPayment,
  ProviderJobLog,
  Job,
  PortfolioForwardProjection,
  PortfolioDailySnapshot,
  Scenario,
  ScenarioReturn,
  HouseholdPlan,
  Insight,
  PlannedEvent,
  FinancialGoal,
  Subscription,
  AiReviewRun,
  MoneyLeakDismissal,
  TaxReserveSetting,
  MonthlyClosePeriod,
  MonthlyCloseTask,
  Purchase,
  CashflowSettings,
  Notification,
  NotificationPreference,
  BudgetAlertState,
};
