import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class FxRate extends Model<
  InferAttributes<FxRate>,
  InferCreationAttributes<FxRate>
> {
  declare id: CreationOptional<number>;
  declare fromCurrency: string;
  declare toCurrency: string;
  /** The date (YYYY-MM-DD) the rate applies to — the BoC publication date. */
  declare ratedDate: string;
  /**
   * Rate stored as a DECIMAL-backed string, matching the SecurityPrice.price
   * pattern. Callers should use Number(row.rate) for arithmetic.
   */
  declare rate: string;
  declare source: CreationOptional<string>;
  declare fetchedAt: Date;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initFxRate(sequelize: Sequelize): typeof FxRate {
  FxRate.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      fromCurrency: {
        type: DataTypes.STRING(3),
        field: 'from_currency',
        allowNull: false,
      },
      toCurrency: {
        type: DataTypes.STRING(3),
        field: 'to_currency',
        allowNull: false,
      },
      ratedDate: {
        type: DataTypes.STRING(10),
        field: 'rated_date',
        allowNull: false,
      },
      rate: { type: DataTypes.DECIMAL(20, 8), allowNull: false },
      source: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: 'bank_of_canada',
      },
      fetchedAt: {
        type: DataTypes.DATE,
        field: 'fetched_at',
        allowNull: false,
      },
    } as ModelAttributes<FxRate>,
    {
      sequelize,
      modelName: 'FxRate',
      tableName: 'fx_rates',
      underscored: true,
      timestamps: true,
    }
  );
  return FxRate;
}
