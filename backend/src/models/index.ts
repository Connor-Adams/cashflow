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
import { PartnerSettlement, initPartnerSettlement } from './PartnerSettlement';
import { BudgetTarget, initBudgetTarget } from './BudgetTarget';
import { AiSuggestion, initAiSuggestion } from './AiSuggestion';
import { ExternalOrder, initExternalOrder } from './ExternalOrder';
import { ExternalOrderItem, initExternalOrderItem } from './ExternalOrderItem';
import { ExternalOrderTender, initExternalOrderTender } from './ExternalOrderTender';
import { TransactionOrderLink, initTransactionOrderLink } from './TransactionOrderLink';
import { TransactionSignal, initTransactionSignal } from './TransactionSignal';
import { Security, initSecurity } from './Security';
import { InvestmentActivity, initInvestmentActivity } from './InvestmentActivity';
import { HoldingSnapshot, initHoldingSnapshot } from './HoldingSnapshot';
import { SecurityPrice, initSecurityPrice } from './SecurityPrice';
import { FxRate, initFxRate } from './FxRate';
import { UserEmailIntegration, initUserEmailIntegration } from './UserEmailIntegration';
import { ReceiptSenderAllowlist, initReceiptSenderAllowlist } from './ReceiptSenderAllowlist';
import { ProcessedEmailMessage, initProcessedEmailMessage } from './ProcessedEmailMessage';
import { UserCaptureToken, initUserCaptureToken } from './UserCaptureToken';
import { Entity, initEntity } from './Entity';

initUser(sequelize);
initSession(sequelize);
initHousehold(sequelize);
initHouseholdMember(sequelize);
initHouseholdInvite(sequelize);
initContact(sequelize);
initPartnerSettlement(sequelize);
initBudgetTarget(sequelize);
initAccount(sequelize);
initRule(sequelize);
initTransaction(sequelize);
initImportHistory(sequelize);
initReceipt(sequelize);
initAiSuggestion(sequelize);
initExternalOrder(sequelize);
initExternalOrderItem(sequelize);
initExternalOrderTender(sequelize);
initTransactionOrderLink(sequelize);
initTransactionSignal(sequelize);
initSecurity(sequelize);
initInvestmentActivity(sequelize);
initHoldingSnapshot(sequelize);
initSecurityPrice(sequelize);
initFxRate(sequelize);
initUserEmailIntegration(sequelize);
initReceiptSenderAllowlist(sequelize);
initProcessedEmailMessage(sequelize);
initUserCaptureToken(sequelize);
initEntity(sequelize);

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
User.hasMany(Session, { foreignKey: 'user_id', as: 'sessions' });
Session.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
Household.hasMany(HouseholdMember, { foreignKey: 'household_id', as: 'members' });
HouseholdMember.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });
HouseholdMember.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
Household.hasMany(Contact, { foreignKey: 'household_id', as: 'contacts' });
Contact.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });
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
Rule.hasMany(Transaction, {
  foreignKey: 'applied_rule_id',
  as: 'appliedTransactions',
});
Transaction.belongsTo(Rule, { foreignKey: 'applied_rule_id', as: 'appliedRule' });
Transaction.hasMany(Receipt, { foreignKey: 'transaction_id', as: 'receipts' });
Receipt.belongsTo(Transaction, { foreignKey: 'transaction_id', as: 'transaction' });
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

export {
  sequelize,
  User,
  Session,
  Household,
  HouseholdMember,
  HouseholdInvite,
  Contact,
  PartnerSettlement,
  BudgetTarget,
  Account,
  Rule,
  Transaction,
  ImportHistory,
  Receipt,
  AiSuggestion,
  ExternalOrder,
  ExternalOrderItem,
  ExternalOrderTender,
  TransactionOrderLink,
  TransactionSignal,
  Security,
  InvestmentActivity,
  HoldingSnapshot,
  SecurityPrice,
  FxRate,
  UserEmailIntegration,
  ReceiptSenderAllowlist,
  ProcessedEmailMessage,
  UserCaptureToken,
  Entity,
};
