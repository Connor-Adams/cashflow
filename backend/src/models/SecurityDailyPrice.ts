import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class SecurityDailyPrice extends Model<
  InferAttributes<SecurityDailyPrice>,
  InferCreationAttributes<SecurityDailyPrice>
> {
  declare id: CreationOptional<number>;
  declare securityId: number;
  declare date: string; // 'YYYY-MM-DD' (DATEONLY)
  declare open: string | null;
  declare high: string | null;
  declare low: string | null;
  declare close: string;
  declare adjClose: string;
  declare volume: number | null;
  declare source: CreationOptional<string>;
  declare fetchedAt: Date;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initSecurityDailyPrice(
  sequelize: Sequelize,
): typeof SecurityDailyPrice {
  SecurityDailyPrice.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      securityId: {
        type: DataTypes.INTEGER,
        field: 'security_id',
        allowNull: false,
      },
      date: { type: DataTypes.DATEONLY, allowNull: false },
      open: { type: DataTypes.DECIMAL(20, 8), allowNull: true },
      high: { type: DataTypes.DECIMAL(20, 8), allowNull: true },
      low: { type: DataTypes.DECIMAL(20, 8), allowNull: true },
      close: { type: DataTypes.DECIMAL(20, 8), allowNull: false },
      adjClose: {
        type: DataTypes.DECIMAL(20, 8),
        field: 'adj_close',
        allowNull: false,
      },
      volume: { type: DataTypes.BIGINT, allowNull: true },
      source: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'alpha_vantage',
      },
      fetchedAt: {
        type: DataTypes.DATE,
        field: 'fetched_at',
        allowNull: false,
      },
    } as ModelAttributes<SecurityDailyPrice>,
    {
      sequelize,
      modelName: 'SecurityDailyPrice',
      tableName: 'security_daily_prices',
      underscored: true,
      timestamps: true,
    },
  );
  return SecurityDailyPrice;
}
