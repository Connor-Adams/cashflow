import { sequelize } from '../db';
import { Account, initAccount } from './Account';
import { Rule, initRule } from './Rule';
import { Transaction, initTransaction } from './Transaction';
import { ImportHistory, initImportHistory } from './ImportHistory';

initAccount(sequelize);
initRule(sequelize);
initTransaction(sequelize);
initImportHistory(sequelize);

Account.hasMany(Transaction, { foreignKey: 'account_id', as: 'transactions' });
Transaction.belongsTo(Account, { foreignKey: 'account_id', as: 'account' });
Rule.hasMany(Transaction, {
  foreignKey: 'applied_rule_id',
  as: 'appliedTransactions',
});
Transaction.belongsTo(Rule, { foreignKey: 'applied_rule_id', as: 'appliedRule' });

export { sequelize, Account, Rule, Transaction, ImportHistory };
