// Sequelize `declare` fields are runtime schema, not consumed via .member access.
// fallow-ignore-file unused-class-member
import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class ExternalOrderTender extends Model<
  InferAttributes<ExternalOrderTender>,
  InferCreationAttributes<ExternalOrderTender>
> {
  declare id: CreationOptional<number>;
  declare externalOrderId: number;
  declare sequence: CreationOptional<number>;
  declare paymentLast4: string | null;
  declare network: string | null;
  declare amount: string;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initExternalOrderTender(sequelize: Sequelize): typeof ExternalOrderTender {
  ExternalOrderTender.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      externalOrderId: {
        type: DataTypes.INTEGER,
        field: 'external_order_id',
        allowNull: false,
      },
      sequence: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      paymentLast4: { type: DataTypes.STRING(4), field: 'payment_last4', allowNull: true },
      network: { type: DataTypes.STRING(32), allowNull: true },
      amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    } as ModelAttributes<ExternalOrderTender>,
    {
      sequelize,
      modelName: 'ExternalOrderTender',
      tableName: 'external_order_tenders',
      underscored: true,
      timestamps: true,
    }
  );
  return ExternalOrderTender;
}
