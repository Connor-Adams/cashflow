'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('partner_settlements', 'recorded_by_user_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL',
    });
    // Backfill: attribute legacy settlements to the household owner ("me" today).
    await queryInterface.sequelize.query(`
      UPDATE partner_settlements
      SET recorded_by_user_id = (
        SELECT m.user_id FROM household_members m
        WHERE m.household_id = partner_settlements.household_id AND m.role = 'owner'
        ORDER BY m.id ASC LIMIT 1
      )
      WHERE recorded_by_user_id IS NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('partner_settlements', 'recorded_by_user_id');
  },
};
