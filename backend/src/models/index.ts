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
import { AiSuggestion, initAiSuggestion } from './AiSuggestion';
import { ExternalOrder, initExternalOrder } from './ExternalOrder';
import { ExternalOrderItem, initExternalOrderItem } from './ExternalOrderItem';
import { TransactionOrderLink, initTransactionOrderLink } from './TransactionOrderLink';

initUser(sequelize);
initSession(sequelize);
initHousehold(sequelize);
initHouseholdMember(sequelize);
initHouseholdInvite(sequelize);
initContact(sequelize);
initAccount(sequelize);
initRule(sequelize);
initTransaction(sequelize);
initImportHistory(sequelize);
initReceipt(sequelize);
initAiSuggestion(sequelize);
initExternalOrder(sequelize);
initExternalOrderItem(sequelize);
initTransactionOrderLink(sequelize);

Account.hasMany(Transaction, { foreignKey: 'account_id', as: 'transactions' });
Transaction.belongsTo(Account, { foreignKey: 'account_id', as: 'account' });
User.hasMany(Session, { foreignKey: 'user_id', as: 'sessions' });
Session.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
Household.hasMany(HouseholdMember, { foreignKey: 'household_id', as: 'members' });
HouseholdMember.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });
HouseholdMember.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
Household.hasMany(Contact, { foreignKey: 'household_id', as: 'contacts' });
Contact.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });
Transaction.belongsTo(Contact, { foreignKey: 'ownership_contact_id', as: 'ownershipContact' });
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

export {
  sequelize,
  User,
  Session,
  Household,
  HouseholdMember,
  HouseholdInvite,
  Contact,
  Account,
  Rule,
  Transaction,
  ImportHistory,
  Receipt,
  AiSuggestion,
  ExternalOrder,
  ExternalOrderItem,
  TransactionOrderLink,
};
