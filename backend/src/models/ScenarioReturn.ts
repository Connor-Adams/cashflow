import {
  Model, DataTypes, type Sequelize, type ModelAttributes,
  InferAttributes, InferCreationAttributes, CreationOptional,
} from 'sequelize';

export class ScenarioReturn extends Model<
  InferAttributes<ScenarioReturn>, InferCreationAttributes<ScenarioReturn>
> {
  declare id: CreationOptional<number>;
  declare scenarioId: number;
  declare factsHash: string;
  declare computedAt: Date;
  declare lines: unknown[];
  declare totals: Record<string, unknown>;
  declare warnings: string[];
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initScenarioReturn(sequelize: Sequelize): typeof ScenarioReturn {
  ScenarioReturn.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      scenarioId: { type: DataTypes.INTEGER, field: 'scenario_id', allowNull: false },
      factsHash: { type: DataTypes.STRING(64), field: 'facts_hash', allowNull: false },
      computedAt: { type: DataTypes.DATE, field: 'computed_at', allowNull: false },
      lines: { type: DataTypes.JSON, allowNull: false },
      totals: { type: DataTypes.JSON, allowNull: false },
      warnings: { type: DataTypes.JSON, allowNull: false },
    } as ModelAttributes<ScenarioReturn>,
    {
      sequelize,
      modelName: 'ScenarioReturn',
      tableName: 'scenario_returns',
      underscored: true,
      timestamps: true,
      indexes: [
        {
          name: 'scenario_returns_scenario_hash_unique',
          unique: true,
          fields: ['scenario_id', 'facts_hash'],
        },
      ],
    }
  );
  return ScenarioReturn;
}
