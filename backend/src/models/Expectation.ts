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
 * Expectation — the canonical Cashflow primitive for any future financial
 * commitment, regardless of whether it is a one-shot event (formerly
 * PlannedEvent) or a recurring subscription (formerly Subscription).
 *
 * The discriminator is `cadence`: 'one_shot' corresponds to the old
 * PlannedEvent shape; all other cadences correspond to the old Subscription
 * shape. This fold eliminates the duplicated status machine that existed
 * across those two models.
 *
 * Status machine:
 *   planned → posted (confirmed by a real transaction)
 *   planned → skipped (one-time skip; kept in history)
 *   planned → cancelled (no longer expected)
 *   active  → paused | cancelled | needs_review
 *
 * The old routes (/api/planned-events, /api/subscriptions) keep reading from
 * their respective source tables for backwards compat. This model backs the
 * new /api/expectations unified read endpoint.
 */

export type ExpectationCadence =
  | 'one_shot'
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'yearly'
  | 'custom';

export const EXPECTATION_CADENCES: readonly ExpectationCadence[] = [
  'one_shot',
  'weekly',
  'monthly',
  'quarterly',
  'yearly',
  'custom',
] as const;

export type ExpectationStatus =
  | 'planned'
  | 'posted'
  | 'skipped'
  | 'active'
  | 'cancelled'
  | 'paused'
  | 'needs_review';

export const EXPECTATION_STATUSES: readonly ExpectationStatus[] = [
  'planned',
  'posted',
  'skipped',
  'active',
  'cancelled',
  'paused',
  'needs_review',
] as const;

/** Directional type — only meaningful for one-shot (PlannedEvent-origin) rows. */
export type ExpectationType = 'expense' | 'income' | 'transfer' | null;

export const EXPECTATION_TYPES: readonly NonNullable<ExpectationType>[] = [
  'expense',
  'income',
  'transfer',
] as const;

export class Expectation extends Model<
  InferAttributes<Expectation>,
  InferCreationAttributes<Expectation>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare userId: number | null;
  declare accountId: number | null;
  /** Discriminator. 'one_shot' = former PlannedEvent; others = former Subscription. */
  declare cadence: ExpectationCadence;
  declare name: string;
  declare normalizedName: string | null;
  /** DECIMAL(20,4) — transported as string for lossless precision. */
  declare amount: string;
  declare currency: string;
  /** Only set for one-shot / PlannedEvent-origin rows. */
  declare type: ExpectationType;
  declare status: CreationOptional<ExpectationStatus>;
  /** Primary date: next occurrence for recurring rows, the event date for one-shots. */
  declare expectedAt: string | null;
  /** Last charge date — from Subscription-origin rows. */
  declare lastChargeDate: string | null;
  /** iCal RRULE for custom cadences. */
  declare rrule: string | null;
  declare category: string | null;
  declare notes: string | null;
  declare annualizedCost: string | null;
  declare priceChangeDetected: CreationOptional<boolean>;
  declare cancellationUrl: string | null;
  declare source: string | null;
  declare linkedTransactionId: number | null;
  /** Traceability FK — the planned_events.id this row was seeded from. */
  declare sourcePlannedEventId: number | null;
  /** Traceability FK — the subscriptions.id this row was seeded from. */
  declare sourceSubscriptionId: number | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initExpectation(sequelize: Sequelize): typeof Expectation {
  Expectation.init(
    {
      id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.BIGINT,
        field: 'household_id',
        allowNull: false,
      },
      userId: {
        type: DataTypes.BIGINT,
        field: 'user_id',
        allowNull: true,
      },
      accountId: {
        type: DataTypes.BIGINT,
        field: 'account_id',
        allowNull: true,
      },
      cadence: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'one_shot',
      },
      name: { type: DataTypes.STRING(255), allowNull: false },
      normalizedName: {
        type: DataTypes.STRING(255),
        field: 'normalized_name',
        allowNull: true,
      },
      amount: { type: DataTypes.DECIMAL(20, 4), allowNull: false },
      currency: { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'USD' },
      type: { type: DataTypes.STRING(32), allowNull: true },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'planned',
      },
      expectedAt: {
        type: DataTypes.DATEONLY,
        field: 'expected_at',
        allowNull: true,
      },
      lastChargeDate: {
        type: DataTypes.DATEONLY,
        field: 'last_charge_date',
        allowNull: true,
      },
      rrule: { type: DataTypes.STRING(512), allowNull: true },
      category: { type: DataTypes.STRING(255), allowNull: true },
      notes: { type: DataTypes.TEXT, allowNull: true },
      annualizedCost: {
        type: DataTypes.DECIMAL(20, 4),
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
        type: DataTypes.STRING(2048),
        field: 'cancellation_url',
        allowNull: true,
      },
      source: { type: DataTypes.STRING(32), allowNull: true },
      linkedTransactionId: {
        type: DataTypes.BIGINT,
        field: 'linked_transaction_id',
        allowNull: true,
      },
      sourcePlannedEventId: {
        type: DataTypes.BIGINT,
        field: 'source_planned_event_id',
        allowNull: true,
      },
      sourceSubscriptionId: {
        type: DataTypes.BIGINT,
        field: 'source_subscription_id',
        allowNull: true,
      },
    } as ModelAttributes<Expectation>,
    {
      sequelize,
      modelName: 'Expectation',
      tableName: 'expectations',
      underscored: true,
      timestamps: true,
    },
  );
  return Expectation;
}
