'use strict';

async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('client_error_events', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      level: { type: Sequelize.STRING(16), allowNull: false },
      event: { type: Sequelize.STRING(128), allowNull: true },
      message: { type: Sequelize.TEXT, allowNull: false },
      path: { type: Sequelize.STRING(512), allowNull: true },
      request_id: { type: Sequelize.STRING(64), allowNull: true },
      fields_json: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await addIndex(queryInterface, 'client_error_events', ['household_id', 'created_at'], {
      name: 'client_error_events_household_created',
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('client_error_events');
  },
};
