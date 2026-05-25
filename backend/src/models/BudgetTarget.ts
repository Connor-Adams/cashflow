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
 * Budget recurrence period. Stored as a string column (not a true PG enum) so
 * extending the set later — weekly/yearly — does not require a destructive
 * migration. Routes validate the value against `BUDGET_TARGET_PERIODS`.
 */
export type BudgetTargetPeriod = 'monthly';

export const BUDGET_TARGET_PERIODS: readonly BudgetTargetPeriod[] = [
  'monthly',
] as const;

export class BudgetTarget extends Model<
  InferAttributes<BudgetTarget>,
  InferCreationAttributes<BudgetTarget>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  /**
   * Null `category` means "overall" — the budget covers the sum of all
   * spend in the matching currency, not a single category.
   */
  declare category: string | null;
  declare currency: string;
  declare amount: string;
  declare period: CreationOptional<BudgetTargetPeriod>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initBudgetTarget(sequelize: Sequelize): typeof BudgetTarget {
  BudgetTarget.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      category: { type: DataTypes.STRING(128), allowNull: true },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
      period: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'monthly',
      },
    } as ModelAttributes<BudgetTarget>,
    {
      sequelize,
      modelName: 'BudgetTarget',
      tableName: 'budget_targets',
      underscored: true,
      timestamps: true,
    }
  );
  BudgetTarget.addHook('afterSave', async (instance: BudgetTarget, options) => {
    try {
      const { ensureCategory } = await import('../util/ensureCategory');
      await ensureCategory(instance.householdId, instance.category, {
        transaction: options.transaction,
      });
    } catch (e) {
      console.warn('[ensureCategory] BudgetTarget hook failed', e);
    }
  });
  return BudgetTarget;
}
