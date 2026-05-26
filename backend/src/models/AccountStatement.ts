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
 * Account statement record for reconciliation (#242).
 *
 * Represents a single statement period for an account (e.g. a monthly
 * credit-card statement, a quarterly investment statement, or a manual
 * entry by the user). Holds the opening + closing balance the statement
 * itself reports — the route layer compares against the sum of
 * Transactions in the same window to expose any variance.
 *
 * `visibility` mirrors the Account/Transaction pattern: 'private'
 * statements are only visible to the user who created them, 'shared'
 * statements are visible to every member of the household.
 *
 * `reconciled_at` is null until the user accepts the reconciliation. The
 * route enforces that you can only reconcile when variance is zero OR
 * when a non-empty `variance_explanation` has been recorded.
 */
export class AccountStatement extends Model<
  InferAttributes<AccountStatement>,
  InferCreationAttributes<AccountStatement>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare accountId: number;
  declare createdByUserId: number | null;
  declare visibility: CreationOptional<string>;
  /** DATEONLY — inclusive ISO date string. */
  declare periodStart: string;
  /** DATEONLY — inclusive ISO date string. */
  declare periodEnd: string;
  /** DECIMAL(18,4) — stored as string for lossless transport. */
  declare openingBalance: CreationOptional<string>;
  /** DECIMAL(18,4) — stored as string for lossless transport. */
  declare closingBalance: CreationOptional<string>;
  declare currency: CreationOptional<string>;
  declare sourceFilename: string | null;
  declare notes: string | null;
  declare reconciledAt: Date | null;
  declare varianceExplanation: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initAccountStatement(
  sequelize: Sequelize,
): typeof AccountStatement {
  AccountStatement.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      accountId: {
        type: DataTypes.INTEGER,
        field: 'account_id',
        allowNull: false,
      },
      createdByUserId: {
        type: DataTypes.INTEGER,
        field: 'created_by_user_id',
        allowNull: true,
      },
      visibility: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'shared',
      },
      periodStart: {
        type: DataTypes.DATEONLY,
        field: 'period_start',
        allowNull: false,
      },
      periodEnd: {
        type: DataTypes.DATEONLY,
        field: 'period_end',
        allowNull: false,
      },
      openingBalance: {
        type: DataTypes.DECIMAL(18, 4),
        field: 'opening_balance',
        allowNull: false,
        defaultValue: 0,
      },
      closingBalance: {
        type: DataTypes.DECIMAL(18, 4),
        field: 'closing_balance',
        allowNull: false,
        defaultValue: 0,
      },
      currency: {
        type: DataTypes.STRING(3),
        allowNull: false,
        defaultValue: 'CAD',
      },
      sourceFilename: {
        type: DataTypes.STRING(512),
        field: 'source_filename',
        allowNull: true,
      },
      notes: { type: DataTypes.TEXT, allowNull: true },
      reconciledAt: {
        type: DataTypes.DATE,
        field: 'reconciled_at',
        allowNull: true,
      },
      varianceExplanation: {
        type: DataTypes.TEXT,
        field: 'variance_explanation',
        allowNull: true,
      },
    } as ModelAttributes<AccountStatement>,
    {
      sequelize,
      modelName: 'AccountStatement',
      tableName: 'account_statements',
      underscored: true,
      timestamps: true,
    },
  );
  return AccountStatement;
}
