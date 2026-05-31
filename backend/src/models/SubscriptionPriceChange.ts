import {
  Model,
  DataTypes,
  type Sequelize,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class SubscriptionPriceChange extends Model<
  InferAttributes<SubscriptionPriceChange>,
  InferCreationAttributes<SubscriptionPriceChange>
> {
  declare id: CreationOptional<number>;
  declare subscriptionId: number;
  declare householdId: number;
  declare detectedOn: string;
  declare previousAmountCents: number;
  declare newAmountCents: number;
  declare pctChange: string;
  declare currency: string;
  declare triggeringTransactionId: CreationOptional<number | null>;
  declare acknowledgedAt: CreationOptional<Date | null>;
  declare acknowledgedByUserId: CreationOptional<number | null>;
  declare readonly createdAt: CreationOptional<Date>;
}

export function initSubscriptionPriceChange(sequelize: Sequelize): void {
  SubscriptionPriceChange.init(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      subscriptionId: { type: DataTypes.BIGINT, allowNull: false, field: 'subscription_id' },
      householdId: { type: DataTypes.BIGINT, allowNull: false, field: 'household_id' },
      detectedOn: { type: DataTypes.DATEONLY, allowNull: false, field: 'detected_on' },
      previousAmountCents: { type: DataTypes.BIGINT, allowNull: false, field: 'previous_amount_cents' },
      newAmountCents: { type: DataTypes.BIGINT, allowNull: false, field: 'new_amount_cents' },
      pctChange: { type: DataTypes.DECIMAL(6, 3), allowNull: false, field: 'pct_change' },
      currency: { type: DataTypes.CHAR(3), allowNull: false },
      triggeringTransactionId: { type: DataTypes.BIGINT, allowNull: true, field: 'triggering_transaction_id' },
      acknowledgedAt: { type: DataTypes.DATE, allowNull: true, field: 'acknowledged_at', defaultValue: null },
      acknowledgedByUserId: { type: DataTypes.BIGINT, allowNull: true, field: 'acknowledged_by_user_id', defaultValue: null },
      createdAt: { type: DataTypes.DATE, field: 'created_at' },
    },
    {
      sequelize,
      tableName: 'subscription_price_changes',
      timestamps: true,
      updatedAt: false,
      createdAt: 'createdAt',
    },
  );
}
