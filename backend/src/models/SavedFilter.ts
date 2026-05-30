import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

/** Hard cap that mirrors the migration column definition. */
export const SAVED_FILTER_NAME_MAX_LENGTH = 64;

/**
 * SavedFilter (issue #272 — saved filters and filter presets).
 *
 * One row per user-named filter set per page. UNIQUE(user_id, page, name) is
 * enforced at the DB level and re-enforced in the route as `DUPLICATE_NAME`.
 */
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
      id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
      userId: {
        type: DataTypes.BIGINT,
        field: 'user_id',
        allowNull: false,
      },
      name: {
        type: DataTypes.STRING(SAVED_FILTER_NAME_MAX_LENGTH),
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
