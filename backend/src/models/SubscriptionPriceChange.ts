import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
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
  declare triggeringTransactionId: number | null;
  declare acknowledgedAt: Date | null;
  declare acknowledgedByUserId: number | null;
  declare createdAt: CreationOptional<Date>;
}

export function initSubscriptionPriceChange(sequelize: Sequelize): typeof SubscriptionPriceChange {
  SubscriptionPriceChange.init(
    {
      id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
      subscriptionId: {
        type: DataTypes.BIGINT,
        field: 'subscription_id',
        allowNull: false,
      },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      detectedOn: {
        type: DataTypes.DATEONLY,
        field: 'detected_on',
        allowNull: false,
      },
      previousAmountCents: {
        type: DataTypes.BIGINT,
        field: 'previous_amount_cents',
        allowNull: false,
      },
      newAmountCents: {
        type: DataTypes.BIGINT,
        field: 'new_amount_cents',
        allowNull: false,
      },
      pctChange: {
        type: DataTypes.DECIMAL(6, 3),
        field: 'pct_change',
        allowNull: false,
      },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      triggeringTransactionId: {
        type: DataTypes.BIGINT,
        field: 'triggering_transaction_id',
        allowNull: true,
      },
      acknowledgedAt: {
        type: DataTypes.DATE,
        field: 'acknowledged_at',
        allowNull: true,
      },
      acknowledgedByUserId: {
        type: DataTypes.INTEGER,
        field: 'acknowledged_by_user_id',
        allowNull: true,
      },
      createdAt: {
        type: DataTypes.DATE,
        field: 'created_at',
        allowNull: false,
      },
    } as ModelAttributes<SubscriptionPriceChange>,
    {
      sequelize,
      modelName: 'SubscriptionPriceChange',
      tableName: 'subscription_price_changes',
      underscored: true,
      timestamps: false,
    },
  );
  return SubscriptionPriceChange;
}
