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
 * Money leak types surfaced by the detectors (Cashflow #220).
 *
 * Stored as a plain STRING column (not a PG enum) so adding new detector
 * outputs later does not require an ALTER TYPE migration. The route layer
 * validates user-supplied values against MONEY_LEAK_TYPES.
 *
 * Detectors live in backend/src/money_leaks/detect.ts. Each detector emits
 * a stable `identityKey` so dismissals stick across detection refreshes:
 *
 *   subscription_price_increase  → `${subscriptionId}`
 *   small_subscription           → `${subscriptionId}`
 *   recurring_fee                → `${normalizedMerchant}|${currency}`
 *   duplicate_service            → `${currency}|${category}`
 *   delivery_fee_high            → `${currency}|delivery`
 */
export type MoneyLeakType =
  | 'subscription_price_increase'
  | 'small_subscription'
  | 'recurring_fee'
  | 'duplicate_service'
  | 'delivery_fee_high';

export const MONEY_LEAK_TYPES: readonly MoneyLeakType[] = [
  'subscription_price_increase',
  'small_subscription',
  'recurring_fee',
  'duplicate_service',
  'delivery_fee_high',
] as const;

export class MoneyLeakDismissal extends Model<
  InferAttributes<MoneyLeakDismissal>,
  InferCreationAttributes<MoneyLeakDismissal>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare leakType: MoneyLeakType;
  declare identityKey: string;
  declare snapshot: unknown;
  declare dismissedByUserId: number | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initMoneyLeakDismissal(
  sequelize: Sequelize,
): typeof MoneyLeakDismissal {
  MoneyLeakDismissal.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      leakType: {
        type: DataTypes.STRING(64),
        field: 'leak_type',
        allowNull: false,
      },
      identityKey: {
        type: DataTypes.STRING(255),
        field: 'identity_key',
        allowNull: false,
      },
      snapshot: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      dismissedByUserId: {
        type: DataTypes.INTEGER,
        field: 'dismissed_by_user_id',
        allowNull: true,
      },
    } as ModelAttributes<MoneyLeakDismissal>,
    {
      sequelize,
      modelName: 'MoneyLeakDismissal',
      tableName: 'money_leak_dismissals',
      underscored: true,
      timestamps: true,
      indexes: [
        {
          name: 'money_leak_dismissals_household_type_key_unique',
          fields: ['household_id', 'leak_type', 'identity_key'],
          unique: true,
        },
        {
          name: 'money_leak_dismissals_household_id',
          fields: ['household_id'],
        },
      ],
    },
  );
  return MoneyLeakDismissal;
}
