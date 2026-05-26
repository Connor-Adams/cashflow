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
 * Financial goal lifecycle (issue #203).
 *
 * - active: contributes toward target; counted by safe-to-spend / forecast.
 * - paused: user temporarily disabled contributions; still visible, not
 *   factored into required-contribution math.
 * - completed: archived (current_amount reached target_amount or user
 *   manually completed). Kept in DB for history; UI hides by default.
 *
 * Stored as STRING(32) so the set can grow without a destructive migration.
 * Routes validate against `FINANCIAL_GOAL_STATUSES`.
 */
export type FinancialGoalStatus = 'active' | 'paused' | 'completed';

export const FINANCIAL_GOAL_STATUSES: readonly FinancialGoalStatus[] = [
  'active',
  'paused',
  'completed',
] as const;

export class FinancialGoal extends Model<
  InferAttributes<FinancialGoal>,
  InferCreationAttributes<FinancialGoal>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare householdId: number;
  declare name: string;
  /** DECIMAL(14,4) — string for lossless transport. */
  declare targetAmount: string;
  /** DECIMAL(14,4) — defaults to 0. */
  declare currentAmount: CreationOptional<string>;
  declare currency: string;
  /** YYYY-MM-DD (DATEONLY); null = no deadline. */
  declare targetDate: string | null;
  /**
   * User-declared monthly contribution intent (DECIMAL(14,4) as string).
   * When null, the goal's projection endpoint computes the required
   * monthly contribution from (target - current) / months_until_target.
   */
  declare monthlyContribution: string | null;
  /** Optional FK to accounts.id — where contributions are tracked. */
  declare linkedAccountId: number | null;
  /** Higher number sorts to the top in UI; default 0. */
  declare priority: CreationOptional<number>;
  declare status: CreationOptional<FinancialGoalStatus>;
  declare notes: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initFinancialGoal(sequelize: Sequelize): typeof FinancialGoal {
  FinancialGoal.init(
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
      name: { type: DataTypes.STRING(255), allowNull: false },
      targetAmount: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'target_amount',
        allowNull: false,
      },
      currentAmount: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'current_amount',
        allowNull: false,
        defaultValue: 0,
      },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      targetDate: {
        type: DataTypes.DATEONLY,
        field: 'target_date',
        allowNull: true,
      },
      monthlyContribution: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'monthly_contribution',
        allowNull: true,
      },
      linkedAccountId: {
        type: DataTypes.INTEGER,
        field: 'linked_account_id',
        allowNull: true,
      },
      priority: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'active',
      },
      notes: { type: DataTypes.TEXT, allowNull: true },
    } as ModelAttributes<FinancialGoal>,
    {
      sequelize,
      modelName: 'FinancialGoal',
      tableName: 'financial_goals',
      underscored: true,
      timestamps: true,
    }
  );
  return FinancialGoal;
}
