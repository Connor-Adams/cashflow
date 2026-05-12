import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class ExternalOrder extends Model<
  InferAttributes<ExternalOrder>,
  InferCreationAttributes<ExternalOrder>
> {
  declare id: CreationOptional<number>;
  declare householdId: number | null;
  declare createdByUserId: number | null;
  declare vendor: string;
  declare vendorOrderId: string | null;
  declare dedupeKey: string;
  declare orderDate: string | null;
  declare shipmentDate: string | null;
  declare subtotal: string | null;
  declare tax: string | null;
  declare shipping: string | null;
  declare total: string | null;
  declare currency: CreationOptional<string>;
  declare paymentLast4: string | null;
  declare source: string;
  declare rawPayload: unknown | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initExternalOrder(sequelize: Sequelize): typeof ExternalOrder {
  ExternalOrder.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: { type: DataTypes.INTEGER, field: 'household_id', allowNull: true },
      createdByUserId: { type: DataTypes.INTEGER, field: 'created_by_user_id', allowNull: true },
      vendor: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'amazon' },
      vendorOrderId: { type: DataTypes.STRING(128), field: 'vendor_order_id', allowNull: true },
      dedupeKey: { type: DataTypes.STRING(256), field: 'dedupe_key', allowNull: false },
      orderDate: { type: DataTypes.DATEONLY, field: 'order_date', allowNull: true },
      shipmentDate: { type: DataTypes.DATEONLY, field: 'shipment_date', allowNull: true },
      subtotal: { type: DataTypes.DECIMAL(14, 4), allowNull: true },
      tax: { type: DataTypes.DECIMAL(14, 4), allowNull: true },
      shipping: { type: DataTypes.DECIMAL(14, 4), allowNull: true },
      total: { type: DataTypes.DECIMAL(14, 4), allowNull: true },
      currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'CAD' },
      paymentLast4: { type: DataTypes.STRING(4), field: 'payment_last4', allowNull: true },
      source: { type: DataTypes.STRING(32), allowNull: false },
      rawPayload: { type: DataTypes.JSON, field: 'raw_payload', allowNull: true },
    } as ModelAttributes<ExternalOrder>,
    {
      sequelize,
      modelName: 'ExternalOrder',
      tableName: 'external_orders',
      underscored: true,
      timestamps: true,
    }
  );
  return ExternalOrder;
}
