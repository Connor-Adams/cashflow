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
 * Subscription status. Persisted as a STRING column (not a true PG enum) so
 * we can add states like 'trial' later without an ALTER TYPE migration. The
 * routes layer (subscriptions.ts) validates user-supplied values against
 * SUBSCRIPTION_STATUSES.
 */
export type SubscriptionStatus = 'active' | 'cancelled' | 'ignored' | 'unknown';

export const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'active',
  'cancelled',
  'ignored',
  'unknown',
] as const;

/**
 * Subscription billing cadence. Like status, this is persisted as a STRING
 * column (not a true PG enum), so widening the set is additive — no migration
 * is required. The detector (routes/recurring.ts) only ever produces 'monthly'
 * or 'weekly', but a user can correct a misdetected cadence to any of these
 * via PATCH /api/subscriptions/:id (Cashflow #291).
 */
export type SubscriptionCadence =
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'semiannual'
  | 'annual';

export const SUBSCRIPTION_CADENCES: readonly SubscriptionCadence[] = [
  'weekly',
  'monthly',
  'quarterly',
  'semiannual',
  'annual',
] as const;

export class Subscription extends Model<
  InferAttributes<Subscription>,
  InferCreationAttributes<Subscription>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare merchantName: string;
  declare normalizedName: string;
  declare amount: string;
  declare currency: string;
  declare cadence: SubscriptionCadence;
  declare lastChargeDate: string;
  declare nextExpectedDate: string | null;
  declare status: CreationOptional<SubscriptionStatus>;
  declare category: string | null;
  declare annualizedCost: string;
  declare priceChangeDetected: CreationOptional<boolean>;
  declare cancellationUrl: string | null;
  declare notes: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initSubscription(sequelize: Sequelize): typeof Subscription {
  Subscription.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      merchantName: {
        type: DataTypes.STRING(255),
        field: 'merchant_name',
        allowNull: false,
      },
      normalizedName: {
        type: DataTypes.STRING(255),
        field: 'normalized_name',
        allowNull: false,
      },
      amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      cadence: { type: DataTypes.STRING(16), allowNull: false },
      lastChargeDate: {
        type: DataTypes.DATEONLY,
        field: 'last_charge_date',
        allowNull: false,
      },
      nextExpectedDate: {
        type: DataTypes.DATEONLY,
        field: 'next_expected_date',
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'active',
      },
      category: { type: DataTypes.STRING(128), allowNull: true },
      annualizedCost: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'annualized_cost',
        allowNull: false,
      },
      priceChangeDetected: {
        type: DataTypes.BOOLEAN,
        field: 'price_change_detected',
        allowNull: false,
        defaultValue: false,
      },
      cancellationUrl: {
        type: DataTypes.TEXT,
        field: 'cancellation_url',
        allowNull: true,
      },
      notes: { type: DataTypes.TEXT, allowNull: true },
    } as ModelAttributes<Subscription>,
    {
      sequelize,
      modelName: 'Subscription',
      tableName: 'subscriptions',
      underscored: true,
      timestamps: true,
      indexes: [
        {
          name: 'subscriptions_household_name_currency_unique',
          fields: ['household_id', 'normalized_name', 'currency'],
          unique: true,
        },
        {
          name: 'subscriptions_household_status',
          fields: ['household_id', 'status'],
        },
      ],
    },
  );
  return Subscription;
}
