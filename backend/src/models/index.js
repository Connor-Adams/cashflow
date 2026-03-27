const { sequelize } = require('../db');
const defineAccount = require('./Account');
const defineRule = require('./Rule');
const defineTransaction = require('./Transaction');
const defineImportHistory = require('./ImportHistory');

const Account = defineAccount(sequelize);
const Rule = defineRule(sequelize);
const Transaction = defineTransaction(sequelize);
const ImportHistory = defineImportHistory(sequelize);

Account.hasMany(Transaction, { foreignKey: 'account_id', as: 'transactions' });
Transaction.belongsTo(Account, { foreignKey: 'account_id', as: 'account' });
Rule.hasMany(Transaction, {
  foreignKey: 'applied_rule_id',
  as: 'appliedTransactions',
});
Transaction.belongsTo(Rule, { foreignKey: 'applied_rule_id', as: 'appliedRule' });

module.exports = {
  sequelize,
  Account,
  Rule,
  Transaction,
  ImportHistory,
};
