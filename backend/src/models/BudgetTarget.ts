import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
import { logger } from '../observability/logger';

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
      logger.warn({ err: e, model: 'BudgetTarget' }, 'ensure_category_hook_failed');
    }
  });
  return BudgetTarget;
}
