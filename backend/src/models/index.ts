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
import { CostcoProduct, initCostcoProduct } from './CostcoProduct';
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
import {
  DividendReconciliation,
  initDividendReconciliation,
} from './DividendReconciliation';
import { FxRate, initFxRate } from './FxRate';
import { UserEmailIntegration, initUserEmailIntegration } from './UserEmailIntegration';
import { ReceiptSenderAllowlist, initReceiptSenderAllowlist } from './ReceiptSenderAllowlist';
import { ProcessedEmailMessage, initProcessedEmailMessage } from './ProcessedEmailMessage';
import { UserCaptureToken, initUserCaptureToken } from './UserCaptureToken';
import { UserReportingToken, initUserReportingToken } from './UserReportingToken';
import { UserAuditToken, initUserAuditToken } from './UserAuditToken';
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
import { JobRun, initJobRun } from './JobRun';
import { PdfImportBatch, initPdfImportBatch } from './PdfImportBatch';
import { PdfImportItem, initPdfImportItem } from './PdfImportItem';
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
import { AiReviewRun, initAiReviewRun } from './AiReviewRun';
import { CashflowSettings, initCashflowSettings } from './CashflowSettings';
import { CfoBriefing, initCfoBriefing } from './CfoBriefing';
import { TaxReserveSetting, initTaxReserveSetting } from './TaxReserveSetting';
import {
  MonthlyClosePeriod,
  initMonthlyClosePeriod,
} from './MonthlyClosePeriod';
import { MonthlyCloseTask, initMonthlyCloseTask } from './MonthlyCloseTask';
import { Purchase, initPurchase } from './Purchase';
import { Reimbursement, initReimbursement } from './Reimbursement';
import {
  TransactionLargePurchaseReview,
  initTransactionLargePurchaseReview,
} from './TransactionLargePurchaseReview';
import { Notification, initNotification } from './Notification';
import { AuditLog, initAuditLog } from './AuditLog';
import { FinanceEvent, initFinanceEvent } from './FinanceEvent';
import {
  NotificationPreference,
  initNotificationPreference,
} from './NotificationPreference';
import { VaultDocument, initVaultDocument } from './VaultDocument';
import { BudgetAlertState, initBudgetAlertState } from './BudgetAlertState';
import { SavedSearch, initSavedSearch } from './SavedSearch';
import { AccountStatement, initAccountStatement } from './AccountStatement';
import { SyncBackup, initSyncBackup } from './SyncBackup';
import { LiabilityAccount, initLiabilityAccount } from './LiabilityAccount';
import {
  DebtPayoffScenario,
  initDebtPayoffScenario,
} from './DebtPayoffScenario';
import { FinancialScenario, initFinancialScenario } from './FinancialScenario';
import { Label, initLabel } from './Label';
import { TransactionLabel, initTransactionLabel } from './TransactionLabel';
import { Feedback, initFeedback } from './Feedback';
import { ClientErrorEvent, initClientErrorEvent } from './ClientErrorEvent';
import { ServerErrorEvent, initServerErrorEvent } from './ServerErrorEvent';
import { IncomeEntry, initIncomeEntry } from './IncomeEntry';
import { SavedFilter, initSavedFilter } from './SavedFilter';

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
initCostcoProduct(sequelize);
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
initDividendReconciliation(sequelize);
initFxRate(sequelize);
initUserEmailIntegration(sequelize);
initReceiptSenderAllowlist(sequelize);
initProcessedEmailMessage(sequelize);
initUserCaptureToken(sequelize);
initUserReportingToken(sequelize);
initUserAuditToken(sequelize);
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
initJobRun(sequelize);
initPdfImportBatch(sequelize);
initPdfImportItem(sequelize);
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
initAiReviewRun(sequelize);
initCfoBriefing(sequelize);
initTaxReserveSetting(sequelize);
initMonthlyClosePeriod(sequelize);
initMonthlyCloseTask(sequelize);
initPurchase(sequelize);
initReimbursement(sequelize);
initTransactionLargePurchaseReview(sequelize);
initCashflowSettings(sequelize);
initNotification(sequelize);
initNotificationPreference(sequelize);
initAuditLog(sequelize);
initVaultDocument(sequelize);
initFinanceEvent(sequelize);
initBudgetAlertState(sequelize);
initSavedSearch(sequelize);
initAccountStatement(sequelize);
initSyncBackup(sequelize);
initLiabilityAccount(sequelize);
initDebtPayoffScenario(sequelize);
initFinancialScenario(sequelize);
initLabel(sequelize);
initTransactionLabel(sequelize);
initFeedback(sequelize);
initClientErrorEvent(sequelize);
initServerErrorEvent(sequelize);
initIncomeEntry(sequelize);
initSavedFilter(sequelize);

// Transaction labels (issue #270). belongsToMany both directions so a
// transaction can `include` its labels and a label can resolve its
// transactions, through the join model. hasMany on the join model itself
// powers the usageCount aggregate in GET /api/labels.
Household.hasMany(Label, { foreignKey: 'household_id', as: 'labels' });
Label.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });
Transaction.belongsToMany(Label, {
  through: TransactionLabel,
  foreignKey: 'transaction_id',
  otherKey: 'label_id',
  as: 'labels',
});
Label.belongsToMany(Transaction, {
  through: TransactionLabel,
  foreignKey: 'label_id',
  otherKey: 'transaction_id',
  as: 'transactions',
});
Label.hasMany(TransactionLabel, { foreignKey: 'label_id', as: 'links' });
TransactionLabel.belongsTo(Label, { foreignKey: 'label_id', as: 'label' });
Transaction.hasMany(TransactionLabel, { foreignKey: 'transaction_id', as: 'labelLinks' });
TransactionLabel.belongsTo(Transaction, { foreignKey: 'transaction_id', as: 'transaction' });

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

// entity_id attribution for the T1/T2 tax engine. belongsTo gives
// Account/Transaction → Entity navigation; the DB-level FK lives in migration
// 20260618000001 (Postgres only). Reciprocal hasMany matches the repo
// convention for owning associations.
Entity.hasMany(Account, { foreignKey: 'entity_id', as: 'accounts' });
Account.belongsTo(Entity, { foreignKey: 'entity_id', as: 'entity' });
Entity.hasMany(Transaction, { foreignKey: 'entity_id', as: 'transactions' });
Transaction.belongsTo(Entity, { foreignKey: 'entity_id', as: 'entity' });

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
SecurityDividend.hasMany(DividendReconciliation, {
  foreignKey: 'security_dividend_id',
  as: 'reconciliations',
});
DividendReconciliation.belongsTo(SecurityDividend, {
  foreignKey: 'security_dividend_id',
  as: 'dividend',
});
DividendReconciliation.belongsTo(Account, {
  foreignKey: 'account_id',
  as: 'account',
});
DividendReconciliation.belongsTo(Transaction, {
  foreignKey: 'matched_transaction_id',
  as: 'matchedTransaction',
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
// Category tree (subcategories): self-referential parent/children.
Category.belongsTo(Category, { foreignKey: 'parent_id', as: 'parent' });
Category.hasMany(Category, { foreignKey: 'parent_id', as: 'children', onDelete: 'RESTRICT' });
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
Household.hasMany(PlannedEvent, {
  foreignKey: 'household_id',
  as: 'expectations',
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

PdfImportBatch.hasMany(PdfImportItem, { foreignKey: 'batch_id', as: 'items', onDelete: 'CASCADE', hooks: true });
PdfImportItem.belongsTo(PdfImportBatch, { foreignKey: 'batch_id', as: 'batch' });

// CFO briefings (issue #236). Cascades with household; user FK for the
// actor that requested the briefing.
Household.hasMany(CfoBriefing, {
  foreignKey: 'household_id',
  as: 'cfoBriefings',
  onDelete: 'CASCADE',
  hooks: true,
});
CfoBriefing.belongsTo(Household, {
  foreignKey: 'household_id',
  as: 'household',
});
User.hasMany(CfoBriefing, {
  foreignKey: 'user_id',
  as: 'cfoBriefings',
});
CfoBriefing.belongsTo(User, {
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

Household.hasMany(AuditLog, {
  foreignKey: 'household_id',
  as: 'auditLog',
  onDelete: 'CASCADE',
  hooks: true,
});
AuditLog.belongsTo(Household, {
  foreignKey: 'household_id',
  as: 'household',
});
User.hasMany(AuditLog, {
  foreignKey: 'actor_user_id',
  as: 'auditLogEntries',
});
AuditLog.belongsTo(User, {
  foreignKey: 'actor_user_id',
  as: 'actor',
});

Household.hasMany(VaultDocument, {
  foreignKey: 'household_id',
  as: 'vaultDocuments',
  onDelete: 'CASCADE',
  hooks: true,
});
VaultDocument.belongsTo(Household, {
  foreignKey: 'household_id',
  as: 'household',
});
User.hasMany(VaultDocument, {
  foreignKey: 'uploaded_by_user_id',
  as: 'vaultDocuments',
});
VaultDocument.belongsTo(User, {
  foreignKey: 'uploaded_by_user_id',
  as: 'uploadedByUser',
});

// Finance domain events (issue #238) — append-only stream parallel to
// audit_log. Cascade on household delete so removing a household
// removes its event stream too.
Household.hasMany(FinanceEvent, {
  foreignKey: 'household_id',
  as: 'financeEvents',
  onDelete: 'CASCADE',
  hooks: true,
});
FinanceEvent.belongsTo(Household, {
  foreignKey: 'household_id',
  as: 'household',
});
User.hasMany(FinanceEvent, {
  foreignKey: 'actor_user_id',
  as: 'financeEventsEmitted',
});
FinanceEvent.belongsTo(User, {
  foreignKey: 'actor_user_id',
  as: 'actor',
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

// Reimbursement claims (issue #216). 1:N from the original outlay
// transaction; a second belongsTo links the matched incoming repayment.
// Cascade on transaction/household delete; the repayment link and party
// Contact use SET NULL (handled at the DB level by the migration) so an
// un-match or contact removal keeps the claim intact.
Transaction.hasMany(Reimbursement, {
  foreignKey: 'transaction_id',
  as: 'reimbursements',
  onDelete: 'CASCADE',
  hooks: true,
});
Reimbursement.belongsTo(Transaction, {
  foreignKey: 'transaction_id',
  as: 'transaction',
});
Transaction.hasMany(Reimbursement, {
  foreignKey: 'repayment_transaction_id',
  as: 'reimbursementRepayments',
});
Reimbursement.belongsTo(Transaction, {
  foreignKey: 'repayment_transaction_id',
  as: 'repaymentTransaction',
});
Household.hasMany(Reimbursement, {
  foreignKey: 'household_id',
  as: 'reimbursements',
  onDelete: 'CASCADE',
  hooks: true,
});
Reimbursement.belongsTo(Household, {
  foreignKey: 'household_id',
  as: 'household',
});
Contact.hasMany(Reimbursement, {
  foreignKey: 'contact_id',
  as: 'reimbursements',
});
Reimbursement.belongsTo(Contact, {
  foreignKey: 'contact_id',
  as: 'contact',
});
User.hasMany(Reimbursement, {
  foreignKey: 'created_by_user_id',
  as: 'createdReimbursements',
});
Reimbursement.belongsTo(User, {
  foreignKey: 'created_by_user_id',
  as: 'createdByUser',
});

// AccountStatement (issue #242). A statement belongs to one Account; an
// Account can have many statements over time. Household and creator
// associations mirror the Account model so authorization checks via
// visibility + createdByUserId compose cleanly.
Household.hasMany(AccountStatement, {
  foreignKey: 'household_id',
  as: 'accountStatements',
  onDelete: 'CASCADE',
  hooks: true,
});
AccountStatement.belongsTo(Household, {
  foreignKey: 'household_id',
  as: 'household',
});
Account.hasMany(AccountStatement, {
  foreignKey: 'account_id',
  as: 'statements',
  onDelete: 'CASCADE',
  hooks: true,
});
AccountStatement.belongsTo(Account, {
  foreignKey: 'account_id',
  as: 'account',
});
User.hasMany(AccountStatement, {
  foreignKey: 'created_by_user_id',
  as: 'accountStatements',
});
AccountStatement.belongsTo(User, {
  foreignKey: 'created_by_user_id',
  as: 'createdByUser',
});

// Large purchase review sidecar (issue #244). 1:1 with transactions; mirrors
// the return-metadata sidecar pattern. Cascade on transaction delete so the
// sidecar is never orphaned.
Transaction.hasOne(TransactionLargePurchaseReview, {
  foreignKey: 'transaction_id',
  as: 'largePurchaseReview',
  onDelete: 'CASCADE',
  hooks: true,
});
TransactionLargePurchaseReview.belongsTo(Transaction, {
  foreignKey: 'transaction_id',
  as: 'transaction',
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

// SavedSearch (issue #235). One row per user-named query string; cascades
// on user delete so we never orphan rows when a user is removed.
User.hasMany(SavedSearch, {
  foreignKey: 'user_id',
  as: 'savedSearches',
  onDelete: 'CASCADE',
  hooks: true,
});
SavedSearch.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// Financial scenario planner (issue #213). Scenarios cascade on household
// delete and user delete. Each scenario belongs to both a household and the
// user who created it — isolating per household is enforced by householdWhere().
Household.hasMany(FinancialScenario, {
  foreignKey: 'household_id',
  as: 'financialScenarios',
  onDelete: 'CASCADE',
  hooks: true,
});
FinancialScenario.belongsTo(Household, {
  foreignKey: 'household_id',
  as: 'household',
});
User.hasMany(FinancialScenario, {
  foreignKey: 'user_id',
  as: 'financialScenarios',
  onDelete: 'CASCADE',
  hooks: true,
});
FinancialScenario.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'user',
});

// Sync backups (issue #239). No CASCADE on household delete: the audit
// history is useful diagnostic context, so we keep the rows around even
// if the household is later removed. The intentionally-loose FK (no
// constraint) matches the migration.
Household.hasMany(SyncBackup, {
  foreignKey: 'household_id',
  as: 'syncBackups',
});
SyncBackup.belongsTo(Household, {
  foreignKey: 'household_id',
  as: 'household',
});
User.hasMany(SyncBackup, {
  foreignKey: 'user_id',
  as: 'syncBackups',
});
SyncBackup.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'user',
});

// LiabilityAccount (issue #202). 1:1 sidecar for an Account whose type is a
// liability kind. account_id is UNIQUE so we surface it as hasOne; both the
// account and household teardown cascade-remove the profile.
Account.hasOne(LiabilityAccount, {
  foreignKey: 'account_id',
  as: 'liabilityProfile',
  onDelete: 'CASCADE',
  hooks: true,
});
LiabilityAccount.belongsTo(Account, {
  foreignKey: 'account_id',
  as: 'account',
});
Household.hasMany(LiabilityAccount, {
  foreignKey: 'household_id',
  as: 'liabilityAccounts',
  onDelete: 'CASCADE',
  hooks: true,
});
LiabilityAccount.belongsTo(Household, {
  foreignKey: 'household_id',
  as: 'household',
});
// Credit-card payment planner (#243). The funding (cash) account a card's
// bill is paid from. SET NULL at the DB level (see the cc-fields migration) so
// deleting the funding account unlinks the profile rather than removing it.
LiabilityAccount.belongsTo(Account, {
  foreignKey: 'payment_account_id',
  as: 'paymentAccount',
});

// DebtPayoffScenario (issue #202). Household-scoped saved payoff plans. The
// creating user is kept loosely (SET NULL) so a scenario survives the user's
// removal; the household teardown cascade-removes scenarios.
Household.hasMany(DebtPayoffScenario, {
  foreignKey: 'household_id',
  as: 'debtPayoffScenarios',
  onDelete: 'CASCADE',
  hooks: true,
});
DebtPayoffScenario.belongsTo(Household, {
  foreignKey: 'household_id',
  as: 'household',
});
User.hasMany(DebtPayoffScenario, {
  foreignKey: 'user_id',
  as: 'debtPayoffScenarios',
});
DebtPayoffScenario.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'user',
});

// SavedFilter (issue #272). One row per user-named filter preset scoped to a
// page. Cascades on user delete; no household scope (filters are personal).
User.hasMany(SavedFilter, {
  foreignKey: 'user_id',
  as: 'savedFilters',
  onDelete: 'CASCADE',
  hooks: true,
});
SavedFilter.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// In-app feedback / bug reports (issue #295). Scoped to both the submitting
// user and their household; both cascade on delete so removing either removes
// the feedback. The owner-only inbox lists via householdWhere().
User.hasMany(Feedback, {
  foreignKey: 'user_id',
  as: 'feedback',
  onDelete: 'CASCADE',
  hooks: true,
});
Feedback.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
Household.hasMany(Feedback, {
  foreignKey: 'household_id',
  as: 'feedback',
  onDelete: 'CASCADE',
  hooks: true,
});
Feedback.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });

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
  CostcoProduct,
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
  UserReportingToken,
  UserAuditToken,
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
  JobRun,
  PdfImportBatch,
  PdfImportItem,
  // Model registry barrel: re-exported for API symmetry though current consumers import from the model file directly.
  // fallow-ignore-next-line unused-export
  PortfolioForwardProjection,
  // Model registry barrel: re-exported for API symmetry though current consumers import from the model file directly.
  // fallow-ignore-next-line unused-export
  PortfolioDailySnapshot,
  Scenario,
  ScenarioReturn,
  HouseholdPlan,
  Insight,
  PlannedEvent,
  FinancialGoal,
  AiReviewRun,
  CfoBriefing,
  TaxReserveSetting,
  MonthlyClosePeriod,
  MonthlyCloseTask,
  Purchase,
  Reimbursement,
  TransactionLargePurchaseReview,
  CashflowSettings,
  Notification,
  NotificationPreference,
  AuditLog,
  FinanceEvent,
  BudgetAlertState,
  SavedSearch,
  VaultDocument,
  AccountStatement,
  SyncBackup,
  LiabilityAccount,
  DebtPayoffScenario,
  FinancialScenario,
  DividendReconciliation,
  Label,
  TransactionLabel,
  Feedback,
  ClientErrorEvent,
  ServerErrorEvent,
  IncomeEntry,
  // Model registry barrel: re-exported for API symmetry though current consumers import from the model file directly.
  // fallow-ignore-next-line unused-export
  SavedFilter,
};
