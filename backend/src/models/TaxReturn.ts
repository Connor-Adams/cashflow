import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class TaxReturn extends Model<
  InferAttributes<TaxReturn>,
  InferCreationAttributes<TaxReturn>
> {
  declare id: CreationOptional<number>;
  declare entityId: number;
  declare year: number;
  declare computedAt: Date;
  declare factsHash: string;
  declare lines: unknown;
  declare totals: unknown;
  declare warnings: unknown;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initTaxReturn(sequelize: Sequelize): typeof TaxReturn {
  TaxReturn.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      entityId: {
        type: DataTypes.INTEGER,
        field: 'entity_id',
        allowNull: false,
      },
      year: { type: DataTypes.INTEGER, allowNull: false },
      computedAt: {
        type: DataTypes.DATE,
        field: 'computed_at',
        allowNull: false,
      },
      factsHash: {
        type: DataTypes.STRING(64),
        field: 'facts_hash',
        allowNull: false,
      },
      lines: { type: DataTypes.JSON, allowNull: false },
      totals: { type: DataTypes.JSON, allowNull: false },
      warnings: { type: DataTypes.JSON, allowNull: false },
    } as ModelAttributes<TaxReturn>,
    {
      sequelize,
      modelName: 'TaxReturn',
      tableName: 'tax_return_snapshots',
      underscored: true,
      timestamps: true,
    }
  );
  return TaxReturn;
}
