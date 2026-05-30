'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('saved_filters', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      user_id: { type: Sequelize.BIGINT, allowNull: false },
      name: { type: Sequelize.STRING(64), allowNull: false },
      page: { type: Sequelize.STRING(32), allowNull: false },
      filter_json: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      position: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addConstraint('saved_filters', {
      fields: ['user_id', 'page', 'name'],
      type: 'unique',
      name: 'saved_filters_user_page_name_unique',
    });
    await queryInterface.addIndex('saved_filters', ['user_id', 'page', 'position']);
  },
  async down(queryInterface) {
    await queryInterface.dropTable('saved_filters');
  },
};
