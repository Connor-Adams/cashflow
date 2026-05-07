'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const desc = await queryInterface.describeTable('users');
    if (!desc.global_role) {
      await queryInterface.addColumn('users', 'global_role', {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'user',
      });
    }

    await queryInterface.sequelize.query(
      `UPDATE users
       SET global_role = 'superadmin'
       WHERE id = (SELECT id FROM users ORDER BY id ASC LIMIT 1)`
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('users', 'global_role');
  },
};
