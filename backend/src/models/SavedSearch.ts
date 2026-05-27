import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

/** Hard caps that mirror the migration column definitions. */
export const SAVED_SEARCH_NAME_MAX_LENGTH = 64;
export const SAVED_SEARCH_QUERY_MAX_LENGTH = 2048;

/**
 * SavedSearch (issue #235 — smart finance search).
 *
 * One row per user-named query STRING (not Transactions-page URL params —
 * that's #272 SavedFilter). UNIQUE(user_id, name) enforced at the DB level
 * and re-enforced in the route as `DUPLICATE_NAME`.
 */
export class SavedSearch extends Model<
  InferAttributes<SavedSearch>,
  InferCreationAttributes<SavedSearch>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare name: string;
  declare query: string;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initSavedSearch(sequelize: Sequelize): typeof SavedSearch {
  SavedSearch.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      userId: {
        type: DataTypes.INTEGER,
        field: 'user_id',
        allowNull: false,
      },
      name: {
        type: DataTypes.STRING(SAVED_SEARCH_NAME_MAX_LENGTH),
        allowNull: false,
      },
      query: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
    } as ModelAttributes<SavedSearch>,
    {
      sequelize,
      modelName: 'SavedSearch',
      tableName: 'saved_searches',
      underscored: true,
      timestamps: true,
    },
  );
  return SavedSearch;
}
