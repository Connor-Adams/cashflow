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
 * Goal lifecycle. Stored as STRING(32) so the value set can grow without a
 * destructive migration. Route layer validates the values.
 *
 * Semantics:
 * - active: in-progress, counts toward required-contribution totals.
 * - paused: user halted contributions (e.g. tight month); still visible but
 *           ignored by safe-to-spend math.
 * - completed: goal hit its target. Archived from default list views.
 *              The DELETE endpoint will still hard-delete on user request.
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
  /** DECIMAL(14,4) — string for lossless transport. Always positive. */
  declare targetAmount: string;
  /** DECIMAL(14,4) — string for lossless transport. Defaults to 0. */
  declare currentAmount: CreationOptional<string>;
  declare currency: string;
  /** YYYY-MM-DD; null = open-ended (no deadline). */
  declare targetDate: string | null;
  /** User-declared intended monthly savings. Distinct from system-computed required. */
  declare monthlyContribution: string | null;
  declare linkedAccountId: number | null;
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
        defaultValue: '0',
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
    },
  );
  return FinancialGoal;
}
