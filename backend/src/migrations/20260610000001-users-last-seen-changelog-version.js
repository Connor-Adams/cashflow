'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const desc = await queryInterface.describeTable('users');
    if (!desc.last_seen_changelog_version) {
      await queryInterface.addColumn('users', 'last_seen_changelog_version', {
        type: Sequelize.STRING(64),
        allowNull: true,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    const desc = await queryInterface.describeTable('users');
    if (desc.last_seen_changelog_version) {
      await queryInterface.removeColumn('users', 'last_seen_changelog_version');
    }
  },
};
