'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('contacts', 'user_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL',
    });
    await queryInterface.addIndex('contacts', ['household_id', 'user_id'], {
      name: 'contacts_household_user_unique',
      unique: true,
      where: { user_id: { [Sequelize.Op.ne]: null } },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('contacts', 'contacts_household_user_unique');
    await queryInterface.removeColumn('contacts', 'user_id');
  },
};
