import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class SecurityPrice extends Model<
  InferAttributes<SecurityPrice>,
  InferCreationAttributes<SecurityPrice>
> {
  declare id: CreationOptional<number>;
  declare securityId: number;
  declare provider: string;
  declare symbol: string;
  declare pricedAt: Date;
  declare price: string;
  declare currency: string;
  declare fetchedAt: Date;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initSecurityPrice(sequelize: Sequelize): typeof SecurityPrice {
  SecurityPrice.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      securityId: {
        type: DataTypes.INTEGER,
        field: 'security_id',
        allowNull: false,
      },
      provider: { type: DataTypes.STRING(64), allowNull: false },
      symbol: { type: DataTypes.STRING(64), allowNull: false },
      pricedAt: {
        type: DataTypes.DATE,
        field: 'priced_at',
        allowNull: false,
      },
      price: { type: DataTypes.DECIMAL(20, 8), allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      fetchedAt: {
        type: DataTypes.DATE,
        field: 'fetched_at',
        allowNull: false,
      },
    } as ModelAttributes<SecurityPrice>,
    {
      sequelize,
      modelName: 'SecurityPrice',
      tableName: 'security_prices',
      underscored: true,
      timestamps: true,
    }
  );
  return SecurityPrice;
}
