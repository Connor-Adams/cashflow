import {
  Model, DataTypes, type Sequelize, type ModelAttributes,
  InferAttributes, InferCreationAttributes, CreationOptional,
} from 'sequelize';

export type ScenarioKind = 'baseline' | 'fork' | 'projection_root';

export class Scenario extends Model<
  InferAttributes<Scenario>, InferCreationAttributes<Scenario>
> {
  declare id: CreationOptional<number>;
  declare parentId: number | null;
  declare entityId: number;
  declare year: number;
  declare name: string;
  declare kind: ScenarioKind;
  declare overrides: Record<string, unknown>;
  declare assumptions: Record<string, unknown>;
  declare nextYearId: number | null;
  declare notes: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initScenario(sequelize: Sequelize): typeof Scenario {
  Scenario.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      parentId: { type: DataTypes.INTEGER, field: 'parent_id', allowNull: true },
      entityId: { type: DataTypes.INTEGER, field: 'entity_id', allowNull: false },
      year: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.STRING(120), allowNull: false },
      kind: { type: DataTypes.STRING(20), allowNull: false },
      overrides: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
      assumptions: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
      nextYearId: { type: DataTypes.INTEGER, field: 'next_year_id', allowNull: true },
      notes: { type: DataTypes.TEXT, allowNull: true },
    } as ModelAttributes<Scenario>,
    {
      sequelize,
      modelName: 'Scenario',
      tableName: 'scenarios',
      underscored: true,
      timestamps: true,
      indexes: [
        {
          name: 'scenarios_entity_year_name_unique',
          unique: true,
          fields: ['entity_id', 'year', 'name'],
        },
        { name: 'scenarios_parent_id', fields: ['parent_id'] },
        { name: 'scenarios_entity_year', fields: ['entity_id', 'year'] },
      ],
    }
  );
  return Scenario;
}
