import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export type CostcoProductStatus = 'pending' | 'resolved' | 'not_found' | 'error';

export class CostcoProduct extends Model<
  InferAttributes<CostcoProduct>,
  InferCreationAttributes<CostcoProduct>
> {
  declare id: CreationOptional<number>;
  declare itemNumber: string;
  declare status: CostcoProductStatus;
  declare imageUrl: string | null;
  declare costcoUrl: string | null;
  declare officialName: string | null;
  declare onlinePrice: string | null;
  declare source: string | null;
  declare attempts: CreationOptional<number>;
  declare fetchedAt: Date | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initCostcoProduct(sequelize: Sequelize): typeof CostcoProduct {
  CostcoProduct.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      itemNumber: { type: DataTypes.STRING(64), field: 'item_number', allowNull: false, unique: true },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending' },
      imageUrl: { type: DataTypes.STRING(1024), field: 'image_url', allowNull: true },
      costcoUrl: { type: DataTypes.STRING(1024), field: 'costco_url', allowNull: true },
      officialName: { type: DataTypes.STRING(512), field: 'official_name', allowNull: true },
      onlinePrice: { type: DataTypes.DECIMAL(14, 4), field: 'online_price', allowNull: true },
      source: { type: DataTypes.STRING(64), allowNull: true },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      fetchedAt: { type: DataTypes.DATE, field: 'fetched_at', allowNull: true },
    } as ModelAttributes<CostcoProduct>,
    {
      sequelize,
      modelName: 'CostcoProduct',
      tableName: 'costco_products',
      underscored: true,
      timestamps: true,
    }
  );
  return CostcoProduct;
}
