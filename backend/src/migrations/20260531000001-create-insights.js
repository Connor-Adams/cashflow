'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('insights', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
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
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      type: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      severity: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'info',
      },
      title: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      entity_type: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      entity_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      status: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'open',
      },
      // Used to dedupe the same logical insight across re-runs. Constructed by
      // the detector from stable inputs (e.g. transaction ids + type). A unique
      // index on (household_id, type, fingerprint) prevents duplicate rows.
      fingerprint: {
        type: Sequelize.STRING(128),
        allowNull: false,
      },
      // Free-form payload — detector-specific structured detail (amounts,
      // comparison values, supporting txn ids). Reserved as JSON because the
      // future AI review pass (#210) reads this exact shape.
      metadata: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      detected_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(queryInterface, 'insights', ['household_id', 'status', 'severity'], {
      name: 'insights_household_status_severity',
    });
    await addIndex(
      queryInterface,
      'insights',
      ['household_id', 'type', 'fingerprint'],
      { name: 'insights_household_type_fingerprint', unique: true }
    );
    await addIndex(queryInterface, 'insights', ['entity_type', 'entity_id'], {
      name: 'insights_entity_lookup',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('insights');
  },
};
