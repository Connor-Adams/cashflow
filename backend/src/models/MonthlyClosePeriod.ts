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
 * Monthly close period (issue #227). One row per (household, period_month).
 *
 * - `periodMonth` is a 'YYYY-MM' string; the route layer validates.
 * - `status` is 'open' (default) or 'closed'. Stored as STRING(16) so the
 *   value set can grow (e.g. 'archived' later) without a destructive
 *   migration.
 * - `openedAt` records when the period was first started (idempotent
 *   POST /start); `closedAt` records when the user marked it closed.
 *   Reopening clears `closedAt` and flips status back to 'open'.
 */
export type MonthlyCloseStatus = 'open' | 'closed';

export const MONTHLY_CLOSE_STATUSES: readonly MonthlyCloseStatus[] = [
  'open',
  'closed',
] as const;

export class MonthlyClosePeriod extends Model<
  InferAttributes<MonthlyClosePeriod>,
  InferCreationAttributes<MonthlyClosePeriod>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare userId: number;
  /** 'YYYY-MM'. */
  declare periodMonth: string;
  declare status: CreationOptional<MonthlyCloseStatus>;
  declare openedAt: Date;
  declare closedAt: Date | null;
  declare notes: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initMonthlyClosePeriod(
  sequelize: Sequelize,
): typeof MonthlyClosePeriod {
  MonthlyClosePeriod.init(
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
        allowNull: false,
      },
      periodMonth: {
        type: DataTypes.STRING(7),
        field: 'period_month',
        allowNull: false,
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'open',
      },
      openedAt: {
        type: DataTypes.DATE,
        field: 'opened_at',
        allowNull: false,
      },
      closedAt: {
        type: DataTypes.DATE,
        field: 'closed_at',
        allowNull: true,
      },
      notes: { type: DataTypes.TEXT, allowNull: true },
    } as ModelAttributes<MonthlyClosePeriod>,
    {
      sequelize,
      modelName: 'MonthlyClosePeriod',
      tableName: 'monthly_close_periods',
      underscored: true,
      timestamps: true,
    },
  );
  return MonthlyClosePeriod;
}
