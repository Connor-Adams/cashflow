'use strict';

/**
 * Liability sidecar table — `liability_accounts` (#202, debt payoff planner).
 *
 * The net-worth dashboard already models liabilities as Accounts whose
 * `account_type` is a liability kind (credit_card | loan | mortgage); their
 * balances are derived from the transaction stream via balanceAtDate. Rather
 * than fork a parallel "liabilities" concept, this is a 1:1 sidecar keyed by
 * `account_id` that adds only the debt-specific fields the payoff planner
 * needs and that have nowhere else to live:
 *
 *   - interest_rate     APR as a percent (e.g. 19.99). DECIMAL(7,4) handles
 *                       rates up to 999.9999% with 4dp precision.
 *   - minimum_payment   required monthly minimum. DECIMAL(14,4) money.
 *   - statement_balance optional override for "amount currently owed". When
 *                       null, the planner derives the owed balance from the
 *                       account's transaction-stream balance. DECIMAL(14,4).
 *   - due_day           optional day-of-month (1-31) the payment is due.
 *
 * `account_id` is UNIQUE so each Account has at most one liability profile.
 * FK delete semantics:
 *   account_id   CASCADE — the sidecar is meaningless without its Account.
 *   household_id CASCADE — household teardown removes its data.
 */

async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('liability_accounts', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      account_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        unique: true,
        references: { model: 'accounts', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      interest_rate: {
        type: Sequelize.DECIMAL(7, 4),
        allowNull: false,
        defaultValue: 0,
      },
      minimum_payment: {
        type: Sequelize.DECIMAL(14, 4),
        allowNull: false,
        defaultValue: 0,
      },
      statement_balance: {
        type: Sequelize.DECIMAL(14, 4),
        allowNull: true,
      },
      due_day: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(queryInterface, 'liability_accounts', ['household_id'], {
      name: 'liability_accounts_household_id',
    });
    // account_id already gets a UNIQUE index from the column definition; add a
    // named unique index too for engines that don't honour inline unique.
    await addIndex(queryInterface, 'liability_accounts', ['account_id'], {
      name: 'liability_accounts_account_id_unique',
      unique: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('liability_accounts');
  },
};
