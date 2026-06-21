'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('accounts', 'bank_account_number', {
      type: Sequelize.STRING(64),
      allowNull: true,
    });

    // Create unique index on (household_id, bank_account_number) to prevent duplicates within a household
    await queryInterface.addIndex(
      'accounts',
      ['household_id', 'bank_account_number'],
      {
        name: 'accounts_household_bank_number_unique',
        unique: true,
        where: {
          bank_account_number: { [Sequelize.Op.ne]: null },
        },
      }
    );
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('accounts', 'accounts_household_bank_number_unique');
    await queryInterface.removeColumn('accounts', 'bank_account_number');
  },
};
