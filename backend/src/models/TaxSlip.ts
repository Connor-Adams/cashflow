import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export type SlipType = 'T4' | 'T5' | 'T3' | 'T4A' | 'T5008';
export type TaxSlipBoxValues = Record<string, number | string>;

export class TaxSlip extends Model<
  InferAttributes<TaxSlip>,
  InferCreationAttributes<TaxSlip>
> {
  declare id: CreationOptional<number>;
  declare entityId: number;
  declare year: number;
  declare slipType: SlipType;
  declare issuer: string;
  declare boxValues: TaxSlipBoxValues;
  declare sourceDocId: number | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initTaxSlip(sequelize: Sequelize): typeof TaxSlip {
  TaxSlip.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      entityId: {
        type: DataTypes.INTEGER,
        field: 'entity_id',
        allowNull: false,
      },
      year: { type: DataTypes.INTEGER, allowNull: false },
      slipType: {
        type: DataTypes.STRING(8),
        field: 'slip_type',
        allowNull: false,
      },
      issuer: { type: DataTypes.STRING(256), allowNull: false },
      boxValues: {
        type: DataTypes.JSON,
        field: 'box_values',
        allowNull: false,
      },
      sourceDocId: {
        type: DataTypes.INTEGER,
        field: 'source_doc_id',
        allowNull: true,
      },
    } as ModelAttributes<TaxSlip>,
    {
      sequelize,
      modelName: 'TaxSlip',
      tableName: 'tax_slips',
      underscored: true,
      timestamps: true,
    }
  );
  return TaxSlip;
}
