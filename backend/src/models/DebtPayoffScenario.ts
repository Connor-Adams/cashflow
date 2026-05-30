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
 * Debt payoff strategies (#202). Stored as STRING(16) so the set can grow
 * without a destructive migration. Routes validate against `PAYOFF_STRATEGIES`
 * from backend/src/debt/payoffPlan.ts.
 *   - avalanche: highest-APR-first (interest optimal)
 *   - snowball:  smallest-balance-first (momentum)
 *   - custom:    user-defined ordering (in payloadJson.order)
 */
export type DebtPayoffStrategy = 'avalanche' | 'snowball' | 'custom';

/**
 * Saved payoff scenario (#202). Persists only the inputs; the amortization
 * schedule is re-derived on read from current liabilities so it stays fresh.
 *
 * `payloadJson` is a TEXT JSON blob holding strategy extras — for 'custom' the
 * ordered debt-id list under `order`, plus an optional `liabilities` snapshot
 * of the debts the plan was built from.
 */
export class DebtPayoffScenario extends Model<
  InferAttributes<DebtPayoffScenario>,
  InferCreationAttributes<DebtPayoffScenario>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare userId: number | null;
  declare name: string;
  declare strategy: CreationOptional<DebtPayoffStrategy>;
  /** DECIMAL(14,4) — string for lossless transport. */
  declare extraMonthlyPayment: CreationOptional<string>;
  declare payloadJson: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initDebtPayoffScenario(sequelize: Sequelize): typeof DebtPayoffScenario {
  DebtPayoffScenario.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      userId: {
        type: DataTypes.INTEGER,
        field: 'user_id',
        allowNull: true,
      },
      name: { type: DataTypes.STRING(255), allowNull: false },
      strategy: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'avalanche',
      },
      extraMonthlyPayment: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'extra_monthly_payment',
        allowNull: false,
        defaultValue: 0,
      },
      payloadJson: {
        type: DataTypes.TEXT,
        field: 'payload_json',
        allowNull: true,
      },
    } as ModelAttributes<DebtPayoffScenario>,
    {
      sequelize,
      modelName: 'DebtPayoffScenario',
      tableName: 'debt_payoff_scenarios',
      underscored: true,
      timestamps: true,
    },
  );
  return DebtPayoffScenario;
}
