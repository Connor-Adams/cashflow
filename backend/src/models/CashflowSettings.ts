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
 * Per-user safe-to-spend settings (issue #199). One row per user
 * (user_id is UNIQUE). Defaults baked into both this model and the create
 * migration so a missing row still yields a sensible safe-to-spend value.
 *
 * Money columns (minimum_cash_buffer) are DECIMAL(14,4) → typed as string
 * for lossless transport, matching the rest of the codebase.
 */
export class CashflowSettings extends Model<
  InferAttributes<CashflowSettings>,
  InferCreationAttributes<CashflowSettings>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  /** DECIMAL(14,4) — money kept out of the safe-to-spend total. Default '0'. */
  declare minimumCashBuffer: CreationOptional<string>;
  /** Forecast horizon used to sum upcoming required expenses. Default 14. */
  declare safeToSpendWindowDays: CreationOptional<number>;
  /** When true, subtract sum of credit_card account balances. Default true. */
  declare includeCreditCardBalance: CreationOptional<boolean>;
  /** When true, subtract required monthly goal contributions. Default true. */
  declare includeGoalContributions: CreationOptional<boolean>;
  /**
   * #375 — drives the Partner Fairness dashboard "Exclude non-partner inflows"
   * toggle. When true (default), positive-amount shared rows whose
   * counterparty_contact_id does NOT reference a partner Contact are dropped
   * from the fairness rollup so the totals, balance, and settlement
   * recommendation reflect only partner-attributable cashflow. When false,
   * the legacy behavior is preserved (every shared row counts).
   */
  declare excludeNonPartnerInflows: CreationOptional<boolean>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export const CASHFLOW_SETTINGS_DEFAULTS = {
  minimumCashBuffer: '0.0000',
  safeToSpendWindowDays: 14,
  includeCreditCardBalance: true,
  includeGoalContributions: true,
  excludeNonPartnerInflows: true,
} as const;

export const MIN_SAFE_TO_SPEND_WINDOW_DAYS = 1;
export const MAX_SAFE_TO_SPEND_WINDOW_DAYS = 365;

export function initCashflowSettings(sequelize: Sequelize): typeof CashflowSettings {
  CashflowSettings.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      userId: {
        type: DataTypes.INTEGER,
        field: 'user_id',
        allowNull: false,
        unique: true,
      },
      minimumCashBuffer: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'minimum_cash_buffer',
        allowNull: false,
        defaultValue: '0',
      },
      safeToSpendWindowDays: {
        type: DataTypes.INTEGER,
        field: 'safe_to_spend_window_days',
        allowNull: false,
        defaultValue: 14,
      },
      includeCreditCardBalance: {
        type: DataTypes.BOOLEAN,
        field: 'include_credit_card_balance',
        allowNull: false,
        defaultValue: true,
      },
      includeGoalContributions: {
        type: DataTypes.BOOLEAN,
        field: 'include_goal_contributions',
        allowNull: false,
        defaultValue: true,
      },
      excludeNonPartnerInflows: {
        type: DataTypes.BOOLEAN,
        field: 'exclude_non_partner_inflows',
        allowNull: false,
        defaultValue: true,
      },
    } as ModelAttributes<CashflowSettings>,
    {
      sequelize,
      modelName: 'CashflowSettings',
      tableName: 'cashflow_settings',
      underscored: true,
      timestamps: true,
    },
  );
  return CashflowSettings;
}
