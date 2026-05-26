import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class PortfolioDailySnapshot extends Model<
  InferAttributes<PortfolioDailySnapshot>,
  InferCreationAttributes<PortfolioDailySnapshot>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare accountId: number;
  declare date: string;
  declare marketValueNative: string;
  declare currency: string;
  declare fxRateToCad: string;
  declare marketValueCad: string;
  declare cashFlowNative: string;
  declare cashFlowCad: string;
  declare isPartial: boolean;
  declare missingDataReasons: string[] | null;
  declare computedAt: Date;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initPortfolioDailySnapshot(sequelize: Sequelize): typeof PortfolioDailySnapshot {
  PortfolioDailySnapshot.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: { type: DataTypes.INTEGER, field: 'household_id', allowNull: false },
      accountId: { type: DataTypes.INTEGER, field: 'account_id', allowNull: false },
      date: { type: DataTypes.DATEONLY, allowNull: false },
      marketValueNative: {
        type: DataTypes.DECIMAL(20, 4),
        field: 'market_value_native',
        allowNull: false,
      },
      currency: { type: DataTypes.STRING(8), allowNull: false },
      fxRateToCad: {
        type: DataTypes.DECIMAL(12, 6),
        field: 'fx_rate_to_cad',
        allowNull: false,
      },
      marketValueCad: {
        type: DataTypes.DECIMAL(20, 4),
        field: 'market_value_cad',
        allowNull: false,
      },
      cashFlowNative: {
        type: DataTypes.DECIMAL(20, 4),
        field: 'cash_flow_native',
        allowNull: false,
        defaultValue: '0',
      },
      cashFlowCad: {
        type: DataTypes.DECIMAL(20, 4),
        field: 'cash_flow_cad',
        allowNull: false,
        defaultValue: '0',
      },
      isPartial: {
        type: DataTypes.BOOLEAN,
        field: 'is_partial',
        allowNull: false,
        defaultValue: false,
      },
      missingDataReasons: {
        type: DataTypes.JSON,
        field: 'missing_data_reasons',
        allowNull: true,
      },
      computedAt: { type: DataTypes.DATE, field: 'computed_at', allowNull: false },
    } as ModelAttributes<PortfolioDailySnapshot>,
    {
      sequelize,
      modelName: 'PortfolioDailySnapshot',
      tableName: 'portfolio_daily_snapshots',
      underscored: true,
      timestamps: true,
    },
  );
  return PortfolioDailySnapshot;
}
