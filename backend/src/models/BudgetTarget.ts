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
 * extending the set later — beyond monthly/weekly/annual — does not require
 * a destructive migration. Routes validate the value against
 * `BUDGET_TARGET_PERIODS`.
 */
export type BudgetTargetPeriod = 'monthly' | 'weekly' | 'annual';

export const BUDGET_TARGET_PERIODS: readonly BudgetTargetPeriod[] = [
  'monthly',
  'weekly',
  'annual',
] as const;

/**
 * Budget scope — which transactions count toward this budget. Issue #201
 * vocabulary: personal | partner | business | household. Cashflow's existing
 * transaction columns express these orthogonally (`visibility`,
 * `ownershipType`, `finalBusiness`); the mapping lives in the routes layer
 * (`scopeWhereClause`). Defaults to `household` so legacy budgets — which
 * implicitly summed across all spend in the household — keep their
 * historical behavior after migration.
 */
export type BudgetTargetScope =
  | 'personal'
  | 'partner'
  | 'business'
  | 'household';

export const BUDGET_TARGET_SCOPES: readonly BudgetTargetScope[] = [
  'personal',
  'partner',
  'business',
  'household',
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
  declare categoryId: CreationOptional<number | null>;
  declare currency: string;
  declare amount: string;
  declare period: CreationOptional<BudgetTargetPeriod>;
  /**
   * Which subset of transactions count toward this budget. Defaults to
   * 'household' on the DB column.
   */
  declare scope: CreationOptional<BudgetTargetScope>;
  /**
   * If true, surplus from one period rolls into the next. We persist the
   * toggle in this PR but the rollover *behavior* is a follow-up.
   */
  declare rolloverEnabled: CreationOptional<boolean>;
  /**
   * If true (issue #215), the budget progress route subtracts the
   * linked-original-purchase amount of every refund whose link points at a
   * txn inside the period bounds. Effect: a $200 purchase that's been
   * refunded in the same period contributes $0 to budget spend.
   */
  declare excludeRefundedPurchases: CreationOptional<boolean>;
  /**
   * Which `spent/target * 100` ratios fire a proactive alert via the daily
   * `budget_breach_check` cron (issue #268). Stored as an integer array;
   * common defaults are `[80, 100, 120]`. The route layer validates entries
   * are integers in 1–500; the cron iterates whatever values are present.
   */
  declare alertThresholds: CreationOptional<number[]>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

/**
 * Bundled defaults for `alertThresholds` on legacy + freshly-created budgets.
 * Mirrors the migration's column default so the cron behaves identically
 * whether or not a user has touched their per-budget settings yet.
 */
export const BUDGET_TARGET_DEFAULT_ALERT_THRESHOLDS: readonly number[] = [
  80, 100, 120,
] as const;

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
      categoryId: { type: DataTypes.INTEGER, field: 'category_id', allowNull: true },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
      period: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'monthly',
      },
      scope: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'household',
      },
      rolloverEnabled: {
        type: DataTypes.BOOLEAN,
        field: 'rollover_enabled',
        allowNull: false,
        defaultValue: false,
      },
      excludeRefundedPurchases: {
        type: DataTypes.BOOLEAN,
        field: 'exclude_refunded_purchases',
        allowNull: false,
        defaultValue: false,
      },
      alertThresholds: {
        type: DataTypes.JSON,
        field: 'alert_thresholds',
        allowNull: false,
        defaultValue: [...BUDGET_TARGET_DEFAULT_ALERT_THRESHOLDS],
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
  BudgetTarget.addHook('beforeSave', async (instance: BudgetTarget, options) => {
    if (instance.householdId == null) return;
    const { reconcileCategoryField } = await import('../categories/reconcileCategoryField');
    await reconcileCategoryField({
      instance, householdId: instance.householdId,
      strField: 'category', idField: 'categoryId',
      transaction: options.transaction ?? undefined,
    });
  });
  return BudgetTarget;
}
