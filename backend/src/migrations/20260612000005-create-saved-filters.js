module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('saved_filters', {
      id: {
        type: Sequelize.BIGINT,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      user_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE',
      },
      name: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      page: {
        type: Sequelize.STRING(32),
        allowNull: false,
      },
      filter_json: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: {},
      },
      position: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });
    await queryInterface.addConstraint('saved_filters', {
      fields: ['user_id', 'page', 'name'],
      type: 'unique',
      name: 'saved_filters_user_id_page_name_unique',
    });
    await queryInterface.addIndex('saved_filters', ['user_id', 'page', 'position'], {
      name: 'saved_filters_user_id_page_position_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('saved_filters');
  },
};
