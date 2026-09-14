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
 * AccountRatePeriod — the interest-rate windows printed on a statement.
 *
 * Spine note: this is reference data hanging off the Account primitive --
 * the same shape as FxRate or SecurityPrice, and a period child exactly as
 * AccountStatement already is. A rate window has no lifecycle of its own,
 * so it introduces no status machine and is NOT a new primitive.
 *
 * Rows come from `parseRbcCreditLineRates`'s `PdfRatePeriod` output
 * (backend/src/import/pdf/types.ts): for a Royal Credit Line statement,
 * RBC prints a "Rate History" table naming, per dated window, the prime
 * rate, the premium/discount applied on top of it, the resulting effective
 * rate, and the interest actually applied that window.
 *
 * `primeRate`/`premium`/`effectiveRate`/`applicableInterest` are DECIMAL
 * columns read back as **strings**, never floats -- a rate here gets
 * multiplied against a balance downstream (Task 3), so float drift is real
 * money. Sequelize returns DECIMAL as a string on Postgres but as a number
 * on SQLite; callers must not assume either representation.
 *
 * Uniqueness: UNIQUE(account_id, from_date) -- re-importing the same
 * statement (or an overlapping one) cannot duplicate a rate window.
 */
export class AccountRatePeriod extends Model<
  InferAttributes<AccountRatePeriod>,
  InferCreationAttributes<AccountRatePeriod>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare accountId: number;
  /** DATEONLY — inclusive ISO date string. */
  declare fromDate: string;
  /** DATEONLY — inclusive ISO date string. */
  declare toDate: string;
  /** DECIMAL(8,4) — stored as string for lossless transport. Not every statement prints it. */
  declare primeRate: string | null;
  /** DECIMAL(8,4) — stored as string for lossless transport. May be negative (a discount). */
  declare premium: string | null;
  /** DECIMAL(8,4) — stored as string for lossless transport. Always present on a rate row. */
  declare effectiveRate: string;
  /** DECIMAL(14,4) — stored as string for lossless transport. The interest RBC actually applied. */
  declare applicableInterest: string | null;
  /** FK to the AccountStatement this rate window was read off, when known. */
  declare sourceStatementId: number | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initAccountRatePeriod(sequelize: Sequelize): typeof AccountRatePeriod {
  AccountRatePeriod.init(
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
      fromDate: {
        type: DataTypes.DATEONLY,
        field: 'from_date',
        allowNull: false,
      },
      toDate: {
        type: DataTypes.DATEONLY,
        field: 'to_date',
        allowNull: false,
      },
      primeRate: {
        type: DataTypes.DECIMAL(8, 4),
        field: 'prime_rate',
        allowNull: true,
      },
      premium: {
        type: DataTypes.DECIMAL(8, 4),
        allowNull: true,
      },
      effectiveRate: {
        type: DataTypes.DECIMAL(8, 4),
        field: 'effective_rate',
        allowNull: false,
      },
      applicableInterest: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'applicable_interest',
        allowNull: true,
      },
      sourceStatementId: {
        type: DataTypes.INTEGER,
        field: 'source_statement_id',
        allowNull: true,
      },
    } as ModelAttributes<AccountRatePeriod>,
    {
      sequelize,
      modelName: 'AccountRatePeriod',
      tableName: 'account_rate_periods',
      underscored: true,
      timestamps: true,
      indexes: [
        {
          unique: true,
          fields: ['account_id', 'from_date'],
          name: 'account_rate_periods_account_from_date',
        },
        { fields: ['household_id'], name: 'account_rate_periods_household_id' },
      ],
    },
  );
  return AccountRatePeriod;
}
