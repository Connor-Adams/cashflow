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
 * Monthly close checklist task (issue #227).
 *
 * One row per task within a period. `taskKey` is a short identifier the
 * frontend maps to a deep link and a copy string (see DEFAULT_TASK_KEYS).
 * `sortOrder` controls render order — tasks are seeded with stable
 * sort indices so a period always renders the same sequence.
 */
export type MonthlyCloseTaskKey =
  | 'imports'
  | 'review_inbox'
  | 'receipts'
  | 'settlements'
  | 'taxes'
  | 'net_worth'
  | 'reports';

export const MONTHLY_CLOSE_TASK_KEYS: readonly MonthlyCloseTaskKey[] = [
  'imports',
  'review_inbox',
  'receipts',
  'settlements',
  'taxes',
  'net_worth',
  'reports',
] as const;

/**
 * Default checklist in render order. Each entry has a stable `sortOrder`
 * starting at 10 (spaced so new items can slot in without re-numbering)
 * and a copy-pair (`title`/`description`) the frontend uses verbatim
 * unless a future spec overrides it.
 */
export type DefaultTaskSpec = {
  taskKey: MonthlyCloseTaskKey;
  title: string;
  description: string;
  sortOrder: number;
  /**
   * Whether this task counts as "critical" — i.e. closing while it has
   * unresolved items should trigger a warning. The route layer enforces.
   */
  critical: boolean;
};

export const DEFAULT_MONTHLY_CLOSE_TASKS: readonly DefaultTaskSpec[] = [
  {
    taskKey: 'imports',
    title: 'Import statements',
    description:
      'Bring this month’s statements and exports into Cashflow.',
    sortOrder: 10,
    critical: false,
  },
  {
    taskKey: 'review_inbox',
    title: 'Review uncategorised transactions',
    description:
      'Triage the review inbox so every transaction has a final category.',
    sortOrder: 20,
    critical: true,
  },
  {
    taskKey: 'receipts',
    title: 'Attach receipts to large purchases',
    description:
      'Pair receipts with their transactions for taxes and item-level detail.',
    sortOrder: 30,
    critical: false,
  },
  {
    taskKey: 'settlements',
    title: 'Settle partner balances',
    description:
      'Record any settlements so the partner balance reflects reality.',
    sortOrder: 40,
    critical: true,
  },
  {
    taskKey: 'taxes',
    title: 'Reserve taxes',
    description:
      'Set aside money for income, sales, and corporate taxes accrued this month.',
    sortOrder: 50,
    critical: false,
  },
  {
    taskKey: 'net_worth',
    title: 'Snapshot net worth',
    description:
      'Capture this month’s net worth and refresh any manual holdings.',
    sortOrder: 60,
    critical: false,
  },
  {
    taskKey: 'reports',
    title: 'Review the month',
    description:
      'Skim the reports and dashboard summary to spot anomalies and wins.',
    sortOrder: 70,
    critical: false,
  },
] as const;

export class MonthlyCloseTask extends Model<
  InferAttributes<MonthlyCloseTask>,
  InferCreationAttributes<MonthlyCloseTask>
> {
  declare id: CreationOptional<number>;
  declare periodId: number;
  declare taskKey: string;
  declare isComplete: CreationOptional<boolean>;
  declare completedAt: Date | null;
  declare completedByUserId: number | null;
  declare notes: string | null;
  declare sortOrder: CreationOptional<number>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initMonthlyCloseTask(
  sequelize: Sequelize,
): typeof MonthlyCloseTask {
  MonthlyCloseTask.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      periodId: {
        type: DataTypes.INTEGER,
        field: 'period_id',
        allowNull: false,
      },
      taskKey: {
        type: DataTypes.STRING(64),
        field: 'task_key',
        allowNull: false,
      },
      isComplete: {
        type: DataTypes.BOOLEAN,
        field: 'is_complete',
        allowNull: false,
        defaultValue: false,
      },
      completedAt: {
        type: DataTypes.DATE,
        field: 'completed_at',
        allowNull: true,
      },
      completedByUserId: {
        type: DataTypes.INTEGER,
        field: 'completed_by_user_id',
        allowNull: true,
      },
      notes: { type: DataTypes.TEXT, allowNull: true },
      sortOrder: {
        type: DataTypes.INTEGER,
        field: 'sort_order',
        allowNull: false,
        defaultValue: 0,
      },
    } as ModelAttributes<MonthlyCloseTask>,
    {
      sequelize,
      modelName: 'MonthlyCloseTask',
      tableName: 'monthly_close_tasks',
      underscored: true,
      timestamps: true,
    },
  );
  return MonthlyCloseTask;
}
