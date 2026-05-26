import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class Household extends Model<
  InferAttributes<Household>,
  InferCreationAttributes<Household>
> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare benchmarkSymbol: CreationOptional<string>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initHousehold(sequelize: Sequelize): typeof Household {
  Household.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      name: { type: DataTypes.STRING(160), allowNull: false },
      benchmarkSymbol: {
        type: DataTypes.STRING(16),
        field: 'benchmark_symbol',
        allowNull: false,
        defaultValue: 'SPY',
      },
    } as ModelAttributes<Household>,
    {
      sequelize,
      modelName: 'Household',
      tableName: 'households',
      underscored: true,
      timestamps: true,
    }
  );
  return Household;
}
