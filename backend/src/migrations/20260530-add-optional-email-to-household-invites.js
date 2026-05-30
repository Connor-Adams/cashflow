'use strict';

const { DataTypes } = require('sequelize');

module.exports = {
  up: async (queryInterface) => {
    // Check if column already exists
    const table = await queryInterface.describeTable('household_invites');
    if (table.optional_email) {
      console.log('Column optional_email already exists, skipping...');
      return;
    }

    await queryInterface.addColumn('household_invites', 'optional_email', {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
    });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('household_invites', 'optional_email');
  },
};
