import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
import type { AssumptionsJson, RunScenarioResult } from '../scenarios/runScenario';

export class FinancialScenario extends Model<
  InferAttributes<FinancialScenario>,
  InferCreationAttributes<FinancialScenario>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare userId: number;
  declare name: string;
  /** Full assumptions payload. */
  declare assumptionsJson: AssumptionsJson;
  /**
   * Nullable snapshot of the last RunScenarioResult. NULL = "never computed".
   * Recomputed by POST /api/financial-scenarios/:id/recompute and on PATCH
   * when assumptions change.
   */
  declare resultJson: RunScenarioResult | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initFinancialScenario(sequelize: Sequelize): typeof FinancialScenario {
  FinancialScenario.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      userId: {
        type: DataTypes.INTEGER,
        field: 'user_id',
        allowNull: false,
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      assumptionsJson: {
        type: DataTypes.JSONB,
        field: 'assumptions_json',
        allowNull: false,
        defaultValue: { name: '', overrides: [] },
      },
      resultJson: {
        type: DataTypes.JSONB,
        field: 'result_json',
        allowNull: true,
        defaultValue: null,
      },
    } as ModelAttributes<FinancialScenario>,
    {
      sequelize,
      modelName: 'FinancialScenario',
      tableName: 'financial_scenarios',
      underscored: true,
      timestamps: true,
      indexes: [
        { name: 'financial_scenarios_household_id', fields: ['household_id'] },
        { name: 'financial_scenarios_user_id', fields: ['user_id'] },
        {
          name: 'financial_scenarios_household_name_unique',
          unique: true,
          fields: ['household_id', 'name'],
        },
      ],
    }
  );
  return FinancialScenario;
}
