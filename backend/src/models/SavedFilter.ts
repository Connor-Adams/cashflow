import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class SavedFilter extends Model<
  InferAttributes<SavedFilter>,
  InferCreationAttributes<SavedFilter>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare name: string;
  declare page: string;
  declare filterJson: Record<string, unknown>;
  declare position: CreationOptional<number>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initSavedFilter(sequelize: Sequelize): typeof SavedFilter {
  SavedFilter.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      userId: {
        type: DataTypes.INTEGER,
        field: 'user_id',
        allowNull: false,
      },
      name: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      page: {
        type: DataTypes.STRING(32),
        allowNull: false,
      },
      filterJson: {
        type: DataTypes.JSONB,
        field: 'filter_json',
        allowNull: false,
        defaultValue: {},
      },
      position: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
    } as ModelAttributes<SavedFilter>,
    {
      sequelize,
      modelName: 'SavedFilter',
      tableName: 'saved_filters',
      underscored: true,
      timestamps: true,
    },
  );
  return SavedFilter;
}
