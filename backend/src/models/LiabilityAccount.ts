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
 * Liability profile sidecar for an Account (#202, debt payoff planner).
 *
 * 1:1 with an Account whose `accountType` is a liability kind (credit_card |
 * loan | mortgage). Holds the debt-specific fields the payoff planner needs;
 * the account's name/currency and balance still live on Account / are derived
 * from the transaction stream, so they are deliberately NOT duplicated here.
 *
 * `statementBalance` is an optional override for "amount currently owed" — when
 * null the planner derives the owed balance from balanceAtDate.
 */
export class LiabilityAccount extends Model<
  InferAttributes<LiabilityAccount>,
  InferCreationAttributes<LiabilityAccount>
> {
  declare id: CreationOptional<number>;
  declare accountId: number;
  declare householdId: number;
  /** APR as a percent, e.g. "19.9900". DECIMAL(7,4) — string for transport. */
  declare interestRate: CreationOptional<string>;
  /** Required monthly minimum. DECIMAL(14,4) — string for transport. */
  declare minimumPayment: CreationOptional<string>;
  /** Optional owed-balance override. DECIMAL(14,4) — string for transport. */
  declare statementBalance: string | null;
  /** Optional day-of-month (1-31) the payment is due. */
  declare dueDay: number | null;
  /**
   * Credit-card payment planner fields (#243). Operational bill-management
   * metadata layered onto the liability sidecar; only meaningful for
   * credit_card accounts.
   */
  /** YYYY-MM-DD (DATEONLY) — when the current statement closed. */
  declare statementDate: string | null;
  /** Whether the card is on autopay. */
  declare autopayEnabled: CreationOptional<boolean>;
  /** full | minimum | fixed — how much autopay draws. NULL when off. */
  declare autopayType: string | null;
  /** Fixed autopay draw when autopayType = 'fixed'. DECIMAL(14,4) string. */
  declare autopayAmount: string | null;
  /** Cash account the bill is paid from. SET NULL on that account's delete. */
  declare paymentAccountId: number | null;
  /**
   * Credit limit (#437). Meaningful only for credit_card accounts; null for
   * loan / mortgage. Validated `> 0 or null` at the route layer.
   * DECIMAL(14,4) — string for transport.
   */
  declare creditLimit: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initLiabilityAccount(sequelize: Sequelize): typeof LiabilityAccount {
  LiabilityAccount.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      accountId: {
        type: DataTypes.INTEGER,
        field: 'account_id',
        allowNull: false,
        unique: true,
      },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      interestRate: {
        type: DataTypes.DECIMAL(7, 4),
        field: 'interest_rate',
        allowNull: false,
        defaultValue: 0,
      },
      minimumPayment: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'minimum_payment',
        allowNull: false,
        defaultValue: 0,
      },
      statementBalance: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'statement_balance',
        allowNull: true,
      },
      dueDay: {
        type: DataTypes.INTEGER,
        field: 'due_day',
        allowNull: true,
      },
      statementDate: {
        type: DataTypes.DATEONLY,
        field: 'statement_date',
        allowNull: true,
      },
      autopayEnabled: {
        type: DataTypes.BOOLEAN,
        field: 'autopay_enabled',
        allowNull: false,
        defaultValue: false,
      },
      autopayType: {
        type: DataTypes.STRING(16),
        field: 'autopay_type',
        allowNull: true,
      },
      autopayAmount: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'autopay_amount',
        allowNull: true,
      },
      paymentAccountId: {
        type: DataTypes.INTEGER,
        field: 'payment_account_id',
        allowNull: true,
      },
      creditLimit: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'credit_limit',
        allowNull: true,
      },
    } as ModelAttributes<LiabilityAccount>,
    {
      sequelize,
      modelName: 'LiabilityAccount',
      tableName: 'liability_accounts',
      underscored: true,
      timestamps: true,
    },
  );
  return LiabilityAccount;
}
