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
 * Per-household tag a user attaches to transactions to mark them as
 * "tax-relevant" with a chosen label (e.g. "Office", "Subcontractor",
 * "Vehicle"). Names are unique within a household.
 */
export class TaxTag extends Model<
  InferAttributes<TaxTag>,
  InferCreationAttributes<TaxTag>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare name: string;
  declare description: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initTaxTag(sequelize: Sequelize): typeof TaxTag {
  TaxTag.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      name: { type: DataTypes.STRING(64), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
    } as ModelAttributes<TaxTag>,
    {
      sequelize,
      modelName: 'TaxTag',
      tableName: 'tax_tags',
      underscored: true,
      timestamps: true,
    },
  );
  return TaxTag;
}
