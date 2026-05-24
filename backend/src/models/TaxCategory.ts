import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class TaxCategory extends Model<
  InferAttributes<TaxCategory>,
  InferCreationAttributes<TaxCategory>
> {
  declare id: CreationOptional<number>;
  declare code: string;
  declare label: string;
  declare t1Line: string | null;
  declare t2Schedule: string | null;
  declare t2Line: string | null;
  declare isDeductible: boolean;
  declare businessUseDefault: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initTaxCategory(sequelize: Sequelize): typeof TaxCategory {
  TaxCategory.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      code: { type: DataTypes.STRING(64), allowNull: false, unique: true },
      label: { type: DataTypes.STRING(160), allowNull: false },
      t1Line: {
        type: DataTypes.STRING(8),
        field: 't1_line',
        allowNull: true,
      },
      t2Schedule: {
        type: DataTypes.STRING(8),
        field: 't2_schedule',
        allowNull: true,
      },
      t2Line: {
        type: DataTypes.STRING(8),
        field: 't2_line',
        allowNull: true,
      },
      isDeductible: {
        type: DataTypes.BOOLEAN,
        field: 'is_deductible',
        allowNull: false,
        defaultValue: false,
      },
      businessUseDefault: {
        type: DataTypes.DECIMAL(5, 2),
        field: 'business_use_default',
        allowNull: true,
      },
    } as ModelAttributes<TaxCategory>,
    {
      sequelize,
      modelName: 'TaxCategory',
      tableName: 'tax_categories',
      underscored: true,
      timestamps: true,
    }
  );
  return TaxCategory;
}
