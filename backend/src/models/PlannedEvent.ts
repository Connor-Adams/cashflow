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
 * Planned financial event types. Stored as STRING(32) so the value set can
 * grow without a destructive migration. Routes validate against
 * `PLANNED_EVENT_TYPES`.
 *
 * Semantics:
 * - income: expected money in (paycheck, bonus, refund, dividend)
 * - expense: expected money out (rent, bill, planned purchase)
 * - transfer: between own accounts (no household-level P&L impact)
 * - settlement: partner balance settlement (relates to PartnerSettlement)
 * - debt_payment: scheduled debt principal/interest paydown
 * - savings: contribution toward a goal or savings account
 */
export type PlannedEventType =
  | 'income'
  | 'expense'
  | 'transfer'
  | 'settlement'
  | 'debt_payment'
  | 'savings';

export const PLANNED_EVENT_TYPES: readonly PlannedEventType[] = [
  'income',
  'expense',
  'transfer',
  'settlement',
  'debt_payment',
  'savings',
] as const;

/**
 * Where the planned event came from. Determines whether it should be
 * user-editable or treated as a system-managed projection.
 */
export type PlannedEventSource =
  | 'manual'
  | 'recurring_detection'
  | 'settlement'
  | 'debt'
  | 'credit_card'
  | 'goal'
  | 'system';

export const PLANNED_EVENT_SOURCES: readonly PlannedEventSource[] = [
  'manual',
  'recurring_detection',
  'settlement',
  'debt',
  'credit_card',
  'goal',
  'system',
] as const;

/**
 * Lifecycle status. `planned` is the default; `posted` means the event has
 * been confirmed against a real transaction (see `linkedTransactionId`).
 * `skipped` and `ignored` distinguish a one-time skip (still counts in
 * historical context) from a hard dismiss.
 */
export type PlannedEventStatus =
  | 'planned'
  | 'posted'
  | 'skipped'
  | 'ignored'
  | 'cancelled';

export const PLANNED_EVENT_STATUSES: readonly PlannedEventStatus[] = [
  'planned',
  'posted',
  'skipped',
  'ignored',
  'cancelled',
] as const;

/**
 * Discriminator separating ordinary planned events from subscription-tracked
 * expectations. Stored as STRING(16); `planned` is the default.
 */
export type ExpectationKind = 'planned' | 'subscription';
export const EXPECTATION_KINDS: readonly ExpectationKind[] = [
  'planned',
  'subscription',
] as const;

/**
 * Billing cadence for subscription-kind expectations. Stored as STRING(16);
 * null for non-subscription planned events.
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

export class PlannedEvent extends Model<
  InferAttributes<PlannedEvent>,
  InferCreationAttributes<PlannedEvent>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare householdId: number;
  declare accountId: number | null;
  declare type: PlannedEventType;
  declare name: string;
  /** DECIMAL(14,4) — string for lossless transport. */
  declare amount: string;
  declare currency: string;
  /** YYYY-MM-DD (DATEONLY). */
  declare expectedDate: string;
  /** Optional RFC 5545 RRULE or JSON blob; one-off when null. */
  declare recurrenceRule: string | null;
  declare source: CreationOptional<PlannedEventSource>;
  declare status: CreationOptional<PlannedEventStatus>;
  declare linkedTransactionId: number | null;
  declare notes: string | null;
  declare kind: CreationOptional<ExpectationKind>;
  declare cadence: SubscriptionCadence | null;
  declare normalizedName: string | null;
  declare lastChargeDate: string | null;
  declare nextExpectedDate: string | null;
  declare annualizedCost: string | null;
  declare priceChangeDetected: CreationOptional<boolean>;
  declare cancellationUrl: string | null;
  declare category: string | null;
  declare statusUncertain: CreationOptional<boolean>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initPlannedEvent(sequelize: Sequelize): typeof PlannedEvent {
  PlannedEvent.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      userId: {
        type: DataTypes.INTEGER,
        field: 'user_id',
        allowNull: false,
      },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      accountId: {
        type: DataTypes.INTEGER,
        field: 'account_id',
        allowNull: true,
      },
      type: { type: DataTypes.STRING(32), allowNull: false },
      name: { type: DataTypes.STRING(255), allowNull: false },
      amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      expectedDate: {
        type: DataTypes.DATEONLY,
        field: 'expected_date',
        allowNull: false,
      },
      recurrenceRule: {
        type: DataTypes.TEXT,
        field: 'recurrence_rule',
        allowNull: true,
      },
      source: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'manual',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'planned',
      },
      linkedTransactionId: {
        type: DataTypes.INTEGER,
        field: 'linked_transaction_id',
        allowNull: true,
      },
      notes: { type: DataTypes.TEXT, allowNull: true },
      kind: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'planned',
      },
      cadence: { type: DataTypes.STRING(16), allowNull: true },
      normalizedName: {
        type: DataTypes.STRING(255),
        field: 'normalized_name',
        allowNull: true,
      },
      lastChargeDate: {
        type: DataTypes.DATEONLY,
        field: 'last_charge_date',
        allowNull: true,
      },
      nextExpectedDate: {
        type: DataTypes.DATEONLY,
        field: 'next_expected_date',
        allowNull: true,
      },
      annualizedCost: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'annualized_cost',
        allowNull: true,
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
      category: { type: DataTypes.STRING(128), allowNull: true },
      statusUncertain: {
        type: DataTypes.BOOLEAN,
        field: 'status_uncertain',
        allowNull: false,
        defaultValue: false,
      },
    } as ModelAttributes<PlannedEvent>,
    {
      sequelize,
      modelName: 'PlannedEvent',
      tableName: 'planned_events',
      underscored: true,
      timestamps: true,
      indexes: [
        {
          name: 'planned_events_subscription_identity_unique',
          unique: true,
          fields: ['household_id', 'normalized_name', 'currency'],
          where: { kind: 'subscription' },
        },
      ],
    }
  );
  return PlannedEvent;
}
