'use strict';

/**
 * docs/superpowers/specs/2026-09-11-account-card-identifiers-design.md
 *
 * Creates `account_card_identifiers`: a child table on Account holding a 1:N
 * relation from an Account to its card last-4s. Today `accounts.short_code`
 * is the only place a last-4 lives, and it is already an import key
 * (`runImport.ts` keys account lookup on it) -- which is why Costco MC's
 * short_code is the literal string 'costco' (the token its import files
 * match on) rather than its real card, 3114. This table lets a last-4 be
 * recorded without overloading short_code, and lets an account carry more
 * than one (a replaced/reissued card, or a shared last-4 across accounts).
 *
 * Unique on (account_id, last4) -- re-harvesting the same card is idempotent.
 * No uniqueness on last4 alone: a last-4 may legitimately map to more than
 * one account (`buildLast4Map` in cardOwnership.ts already returns
 * Map<string, number[]>).
 *
 * Dual-dialect (SQLite + Postgres). Down drops the table.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('account_card_identifiers', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      account_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'accounts', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      last4: { type: Sequelize.STRING(4), allowNull: false },
      source: { type: Sequelize.STRING(64), allowNull: false },
      first_seen_at: { type: Sequelize.DATE, allowNull: false },
      last_seen_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex('account_card_identifiers', ['account_id', 'last4'], {
      unique: true,
      name: 'account_card_identifiers_account_last4',
    });
    await queryInterface.addIndex('account_card_identifiers', ['household_id'], {
      name: 'account_card_identifiers_household_id',
    });
    await queryInterface.addIndex('account_card_identifiers', ['last4'], {
      name: 'account_card_identifiers_last4',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'account_card_identifiers',
      'account_card_identifiers_last4',
    );
    await queryInterface.removeIndex(
      'account_card_identifiers',
      'account_card_identifiers_household_id',
    );
    await queryInterface.removeIndex(
      'account_card_identifiers',
      'account_card_identifiers_account_last4',
    );
    await queryInterface.dropTable('account_card_identifiers');
  },
};
