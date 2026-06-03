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
 * Dividend reconciliation record (issue #305).
 *
 * Links an expected payout — a {@link SecurityDividend} fact (per-security,
 * NO household) — to the actual cash `Transaction` that received it, scoped
 * to a single holding account.
 *
 * Why a join table rather than `security_dividends.matched_transaction_id`?
 * `SecurityDividend` is keyed by `security_id` only and securities are global
 * (shared across households via a nullable `securities.household_id`). One
 * expected dividend therefore applies to *every* account holding the security
 * — a single FK on the dividend row could not represent two households (or two
 * accounts) holding the same security. One reconciliation row per
 * (dividend, holding-account) keeps matching account-scoped. The issue body
 * explicitly allows this ("use a join table — start with single match for
 * v1").
 *
 * Lifecycle: the daily `dividend_reconciliation` job upserts one row per
 * holding account for each in-window dividend, snapshotting `expected_amount`
 * (= per-share amount × shares held at the payment date) and `shares`. It then
 * auto-matches when exactly one candidate transaction is found. Manual
 * match/unmatch via the API flips `matched_transaction_id`/`matched_at` and
 * sets `match_source`. `notified_unmatched_at` dedups the
 * `dividend.unmatched` notification (AC #9) so the alert fires at most once per
 * reconciliation row.
 */
export const DIVIDEND_MATCH_SOURCES = ['auto', 'manual'] as const;
export type DividendMatchSource = (typeof DIVIDEND_MATCH_SOURCES)[number];

export class DividendReconciliation extends Model<
  InferAttributes<DividendReconciliation>,
  InferCreationAttributes<DividendReconciliation>
> {
  declare id: CreationOptional<number>;
  declare securityDividendId: number;
  declare accountId: number;
  declare householdId: number | null;
  declare matchedTransactionId: CreationOptional<number | null>;
  declare matchedAt: CreationOptional<Date | null>;
  declare matchSource: CreationOptional<DividendMatchSource>;
  /** per-share amount × shares held at the payment date (snapshot). */
  declare expectedAmount: CreationOptional<string | null>;
  declare shares: CreationOptional<string | null>;
  declare currency: CreationOptional<string | null>;
  /** Set when a `dividend.unmatched` notification has fired (dedup). */
  declare notifiedUnmatchedAt: CreationOptional<Date | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initDividendReconciliation(
  sequelize: Sequelize,
): typeof DividendReconciliation {
  DividendReconciliation.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      securityDividendId: {
        type: DataTypes.INTEGER,
        field: 'security_dividend_id',
        allowNull: false,
      },
      accountId: {
        type: DataTypes.INTEGER,
        field: 'account_id',
        allowNull: false,
      },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: true,
      },
      matchedTransactionId: {
        type: DataTypes.INTEGER,
        field: 'matched_transaction_id',
        allowNull: true,
        defaultValue: null,
      },
      matchedAt: {
        type: DataTypes.DATE,
        field: 'matched_at',
        allowNull: true,
        defaultValue: null,
      },
      matchSource: {
        type: DataTypes.STRING(16),
        field: 'match_source',
        allowNull: false,
        defaultValue: 'auto',
      },
      expectedAmount: {
        type: DataTypes.DECIMAL(20, 8),
        field: 'expected_amount',
        allowNull: true,
        defaultValue: null,
      },
      shares: {
        type: DataTypes.DECIMAL(28, 10),
        allowNull: true,
        defaultValue: null,
      },
      currency: {
        type: DataTypes.STRING(3),
        allowNull: true,
        defaultValue: null,
      },
      notifiedUnmatchedAt: {
        type: DataTypes.DATE,
        field: 'notified_unmatched_at',
        allowNull: true,
        defaultValue: null,
      },
    } as ModelAttributes<DividendReconciliation>,
    {
      sequelize,
      modelName: 'DividendReconciliation',
      tableName: 'dividend_reconciliations',
      underscored: true,
      timestamps: true,
      indexes: [
        {
          name: 'dividend_reconciliations_dividend_account',
          unique: true,
          fields: ['security_dividend_id', 'account_id'],
        },
        {
          name: 'dividend_reconciliations_matched_transaction',
          fields: ['matched_transaction_id'],
        },
        {
          name: 'dividend_reconciliations_household_matched_at',
          fields: ['household_id', 'matched_at'],
        },
      ],
    },
  );
  return DividendReconciliation;
}
