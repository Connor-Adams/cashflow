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
 * Records that the daily `budget_breach_check` cron has already alerted a
 * given user at a given threshold for a given budget in a given period
 * (issue #268). The UNIQUE constraint on
 * (user_id, budget_target_id, period_key, threshold) is the dedup key the
 * cron probes before calling `enqueueNotification` — so re-running the cron
 * in the same period is an idempotent no-op (AC #5).
 *
 * `period_key` is a free-form short string the cron generates from the
 * budget's recurrence period:
 *   - monthly → 'YYYY-MM'      (e.g. '2026-05')
 *   - weekly  → 'YYYY-Www'     (e.g. '2026-W21', ISO week numbering)
 *   - annual  → 'YYYY'         (e.g. '2026')
 * Keeping period vocabulary in the cron rather than the DB lets us extend
 * the period set (quarterly, fiscal year, …) without a migration.
 *
 * Rows cascade-delete from `budget_targets`, so deleting a budget mid-period
 * cleans up its alert history without a periodic cleanup job (AC #12).
 */
export class BudgetAlertState extends Model<
  InferAttributes<BudgetAlertState>,
  InferCreationAttributes<BudgetAlertState>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare budgetTargetId: number;
  declare periodKey: string;
  declare threshold: number;
  declare alertedAt: CreationOptional<Date>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initBudgetAlertState(
  sequelize: Sequelize,
): typeof BudgetAlertState {
  BudgetAlertState.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      userId: {
        type: DataTypes.INTEGER,
        field: 'user_id',
        allowNull: false,
      },
      budgetTargetId: {
        type: DataTypes.INTEGER,
        field: 'budget_target_id',
        allowNull: false,
      },
      periodKey: {
        type: DataTypes.STRING(16),
        field: 'period_key',
        allowNull: false,
      },
      threshold: {
        type: DataTypes.SMALLINT,
        allowNull: false,
      },
      alertedAt: {
        type: DataTypes.DATE,
        field: 'alerted_at',
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    } as ModelAttributes<BudgetAlertState>,
    {
      sequelize,
      modelName: 'BudgetAlertState',
      tableName: 'budget_alert_states',
      underscored: true,
      timestamps: true,
      indexes: [
        {
          name: 'budget_alert_states_user_budget_period_threshold',
          unique: true,
          fields: ['user_id', 'budget_target_id', 'period_key', 'threshold'],
        },
      ],
    },
  );
  return BudgetAlertState;
}
