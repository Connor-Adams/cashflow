import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

/**
 * merchant_embeddings — household-scoped memoization cache of one embedding
 * vector per distinct merchant_clean per model (issue #792). Derived artifact,
 * NOT a primitive: the vector is a pure function of (merchant_clean, model) and
 * is fully recomputable. The vector is stored as JSON-encoded text so cosine
 * similarity can be computed in JS on both SQLite and Postgres without pgvector.
 */
export class MerchantEmbedding extends Model<
  InferAttributes<MerchantEmbedding>,
  InferCreationAttributes<MerchantEmbedding>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare merchantClean: string;
  /** JSON-encoded float array, e.g. "[0.12,-0.4,...]". */
  declare embedding: string;
  declare dim: number;
  declare model: string;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initMerchantEmbedding(
  sequelize: Sequelize,
): typeof MerchantEmbedding {
  MerchantEmbedding.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      merchantClean: {
        type: DataTypes.TEXT,
        field: 'merchant_clean',
        allowNull: false,
      },
      embedding: { type: DataTypes.TEXT, allowNull: false },
      dim: { type: DataTypes.INTEGER, allowNull: false },
      model: { type: DataTypes.STRING(128), allowNull: false },
    } as ModelAttributes<MerchantEmbedding>,
    {
      sequelize,
      modelName: 'MerchantEmbedding',
      tableName: 'merchant_embeddings',
      underscored: true,
      timestamps: true,
      indexes: [
        {
          unique: true,
          name: 'merchant_embeddings_household_merchant_model_uniq',
          fields: ['household_id', 'merchant_clean', 'model'],
        },
        {
          name: 'merchant_embeddings_household_idx',
          fields: ['household_id'],
        },
      ],
    },
  );
  return MerchantEmbedding;
}
