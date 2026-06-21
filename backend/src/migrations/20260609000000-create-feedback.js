'use strict';

/**
 * In-app feedback / bug reports (issue #295). Each row is a single submission
 * from a user — a bug, feature request, "this is confusing", or other note —
 * with the page URL, browser User-Agent, and app version captured for
 * context. The owner-only inbox lists newest-first scoped to the household.
 *
 * `category` is STRING(32) (not a native enum) so the vocab can grow without a
 * destructive migration; the route validates it against the allowed set.
 * `resolved_at` is null until the owner marks the item resolved.
 *
 * FK delete semantics:
 *   user_id      CASCADE — feedback is meaningless once its author is removed
 *   household_id CASCADE — household teardown removes its data
 *
 * Index `(user_id, created_at)` backs the per-user newest-first reads.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('feedback', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      category: {
        type: Sequelize.STRING(32),
        allowNull: false,
      },
      body: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      current_path: {
        type: Sequelize.STRING(512),
        allowNull: true,
      },
      user_agent: {
        type: Sequelize.STRING(512),
        allowNull: true,
      },
      app_version: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      resolved_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex('feedback', ['user_id', 'created_at'], {
      name: 'feedback_user_id_created_at',
    });
    await queryInterface.addIndex('feedback', ['household_id'], {
      name: 'feedback_household_id',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('feedback', 'feedback_household_id');
    await queryInterface.removeIndex('feedback', 'feedback_user_id_created_at');
    await queryInterface.dropTable('feedback');
  },
};
