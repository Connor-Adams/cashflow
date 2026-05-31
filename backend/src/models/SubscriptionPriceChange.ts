import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

/**
 * Records a detected price change for a subscription (issue #441).
 * One row per (subscription, detected_on) pair; acknowledging sets
 * acknowledged_at. The subscription's priceChangeDetected flag is
 * cleared when the user acknowledges.
 */
export class SubscriptionPriceChange extends Model<
  InferAttributes<SubscriptionPriceChange>,
  InferCreationAttributes<SubscriptionPriceChange>
> {
  declare id: CreationOptional<number>;
  declare subscriptionId: number;
  declare householdId: number;
  /** Amount before the change (stored as string from DECIMAL column). */
  declare previousAmount: string;
  /** Amount after the change (stored as string from DECIMAL column). */
  declare newAmount: string;
  declare currency: string;
  /** DATEONLY: calendar date when the change was first detected. */
  declare detectedOn: string;
  declare acknowledgedAt: Date | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initSubscriptionPriceChange(
  sequelize: Sequelize,
): typeof SubscriptionPriceChange {
  SubscriptionPriceChange.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      subscriptionId: {
        type: DataTypes.INTEGER,
        field: 'subscription_id',
        allowNull: false,
      },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      previousAmount: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'previous_amount',
        allowNull: false,
      },
      newAmount: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'new_amount',
        allowNull: false,
      },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      detectedOn: {
        type: DataTypes.DATEONLY,
        field: 'detected_on',
        allowNull: false,
      },
      acknowledgedAt: {
        type: DataTypes.DATE,
        field: 'acknowledged_at',
        allowNull: true,
      },
    } as ModelAttributes<SubscriptionPriceChange>,
    {
      sequelize,
      modelName: 'SubscriptionPriceChange',
      tableName: 'subscription_price_changes',
      underscored: true,
      timestamps: true,
      indexes: [
        {
          name: 'spc_subscription_detected',
          fields: ['subscription_id', 'detected_on'],
          unique: true,
        },
        {
          name: 'spc_household_unacked',
          fields: ['household_id', 'acknowledged_at'],
        },
      ],
    },
  );
  return SubscriptionPriceChange;
}
