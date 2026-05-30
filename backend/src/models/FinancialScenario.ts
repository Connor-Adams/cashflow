import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

import type { ScenarioAssumption, ScenarioResult } from '../scenarios/applyScenario';

/**
 * Financial scenario planner row (issue #213).
 *
 * Naming note: the tax domain already owns a `scenarios` table / `Scenario`
 * model, so this household-finance feature uses `financial_scenarios` /
 * `FinancialScenario` to avoid a collision.
 *
 * `assumptionsJson` stores the array of hypothetical changes the planner
 * replays; `resultJson` caches the most recent computed comparison so list
 * views render without recomputing. `baseForecastId` is reserved for a future
 * link to a saved forecast (there is no forecast table to FK to today).
 */
export class FinancialScenario extends Model<
  InferAttributes<FinancialScenario>,
  InferCreationAttributes<FinancialScenario>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare householdId: number;
  declare name: string;
  declare baseForecastId: number | null;
  declare assumptionsJson: ScenarioAssumption[];
  declare resultJson: CreationOptional<ScenarioResult | null>;
  declare horizonDays: CreationOptional<number>;
  declare currency: string;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export const FINANCIAL_SCENARIO_DEFAULT_HORIZON_DAYS = 90;
export const MIN_FINANCIAL_SCENARIO_HORIZON_DAYS = 1;
export const MAX_FINANCIAL_SCENARIO_HORIZON_DAYS = 365;

export function initFinancialScenario(sequelize: Sequelize): typeof FinancialScenario {
  FinancialScenario.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      userId: {
        type: DataTypes.INTEGER,
        field: 'user_id',
        allowNull: false,
      },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      name: { type: DataTypes.STRING(255), allowNull: false },
      baseForecastId: {
        type: DataTypes.INTEGER,
        field: 'base_forecast_id',
        allowNull: true,
      },
      assumptionsJson: {
        type: DataTypes.JSON,
        field: 'assumptions_json',
        allowNull: false,
        defaultValue: [],
      },
      resultJson: {
        type: DataTypes.JSON,
        field: 'result_json',
        allowNull: true,
      },
      horizonDays: {
        type: DataTypes.INTEGER,
        field: 'horizon_days',
        allowNull: false,
        defaultValue: FINANCIAL_SCENARIO_DEFAULT_HORIZON_DAYS,
      },
      currency: { type: DataTypes.STRING(3), allowNull: false },
    } as ModelAttributes<FinancialScenario>,
    {
      sequelize,
      modelName: 'FinancialScenario',
      tableName: 'financial_scenarios',
      underscored: true,
      timestamps: true,
    },
  );
  return FinancialScenario;
}
