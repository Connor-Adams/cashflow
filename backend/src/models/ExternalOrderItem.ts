import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class ExternalOrderItem extends Model<
  InferAttributes<ExternalOrderItem>,
  InferCreationAttributes<ExternalOrderItem>
> {
  declare id: CreationOptional<number>;
  declare externalOrderId: number;
  declare title: string;
  declare quantity: CreationOptional<number>;
  declare unitPrice: string | null;
  declare totalPrice: string | null;
  declare inferredCategory: string | null;
  declare businessUsePercent: string | null;
  declare confidence: string | null;
  declare categoryOverride: string | null;
  declare businessUseOverride: string | null;
  declare displayName: string | null;
  declare displayNameConfidence: string | null;
  declare itemNumber: string | null;
  declare rawPayload: unknown | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initExternalOrderItem(sequelize: Sequelize): typeof ExternalOrderItem {
  ExternalOrderItem.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      externalOrderId: {
        type: DataTypes.INTEGER,
        field: 'external_order_id',
        allowNull: false,
      },
      title: { type: DataTypes.STRING(1024), allowNull: false },
      quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      unitPrice: { type: DataTypes.DECIMAL(14, 4), field: 'unit_price', allowNull: true },
      totalPrice: { type: DataTypes.DECIMAL(14, 4), field: 'total_price', allowNull: true },
      inferredCategory: {
        type: DataTypes.STRING(128),
        field: 'inferred_category',
        allowNull: true,
      },
      businessUsePercent: {
        type: DataTypes.DECIMAL(5, 2),
        field: 'business_use_percent',
        allowNull: true,
      },
      confidence: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
      categoryOverride: {
        type: DataTypes.STRING(128),
        field: 'category_override',
        allowNull: true,
      },
      businessUseOverride: {
        type: DataTypes.DECIMAL(5, 2),
        field: 'business_use_override',
        allowNull: true,
      },
      displayName: {
        type: DataTypes.STRING(512),
        field: 'display_name',
        allowNull: true,
      },
      displayNameConfidence: {
        type: DataTypes.DECIMAL(5, 2),
        field: 'display_name_confidence',
        allowNull: true,
      },
      itemNumber: {
        type: DataTypes.STRING(64),
        field: 'item_number',
        allowNull: true,
      },
      rawPayload: { type: DataTypes.JSON, field: 'raw_payload', allowNull: true },
    } as ModelAttributes<ExternalOrderItem>,
    {
      sequelize,
      modelName: 'ExternalOrderItem',
      tableName: 'external_order_items',
      underscored: true,
      timestamps: true,
    }
  );
  return ExternalOrderItem;
}
