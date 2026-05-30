'use strict';

/**
 * Financial scenario planner (issue #213).
 *
 * Creates the `financial_scenarios` table. This is intentionally NOT named
 * `scenarios` — that name is already taken by the tax-domain scenarios table
 * (see migration 20260526014957-scenarios.js). The `FinancialScenario` model
 * maps to this table.
 *
 * Schema notes:
 *   - `household_id` + `user_id` for ownership and isolation.
 *   - `name` is a short display label; max 255 chars.
 *   - `assumptions_json` stores the full AssumptionsJson payload (see
 *     backend/src/scenarios/runScenario.ts for the TypeScript type). JSONB
 *     allows efficient reads without a full table scan.
 *   - `result_json` is a nullable JSONB snapshot of the last RunScenarioResult.
 *     It is recomputed on POST /api/financial-scenarios/:id/recompute and also
 *     recomputed automatically on PATCH (PUT) when the assumptions change.
 *     NULL means "never computed yet" — the UI shows a "Compute" button.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('financial_scenarios', {
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
      name: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      assumptions_json: {
        // Stores the AssumptionsJson payload (overrides + metadata).
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: { name: '', overrides: [] },
      },
      result_json: {
        // Nullable snapshot of the last RunScenarioResult.
        type: Sequelize.JSONB,
        allowNull: true,
        defaultValue: null,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });

    await queryInterface.addIndex('financial_scenarios', ['household_id'], {
      name: 'financial_scenarios_household_id',
    });
    await queryInterface.addIndex('financial_scenarios', ['user_id'], {
      name: 'financial_scenarios_user_id',
    });
    // Unique constraint: scenario names are unique per household to keep
    // the list unambiguous from the user's perspective.
    await queryInterface.addConstraint('financial_scenarios', {
      fields: ['household_id', 'name'],
      type: 'unique',
      name: 'financial_scenarios_household_name_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('financial_scenarios');
  },
};
