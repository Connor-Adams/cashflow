module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('data_exports', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      user_id: { type: Sequelize.BIGINT, allowNull: false },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'queued' },
      requested_at: { type: Sequelize.DATE, allowNull: false },
      ready_at: { type: Sequelize.DATE, allowNull: true },
      expires_at: { type: Sequelize.DATE, allowNull: true },
      storage_key: { type: Sequelize.STRING(256), allowNull: true },
      byte_size: { type: Sequelize.BIGINT, allowNull: true },
      error_message: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('data_exports', ['user_id', 'requested_at'], { order: ['DESC'] });
    await queryInterface.addIndex('data_exports', ['expires_at']);
  },
  async down(queryInterface) {
    await queryInterface.dropTable('data_exports');
  },
};
