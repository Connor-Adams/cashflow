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
 * Insight severities are stored as a plain STRING (not a PG ENUM) so we can
 * add levels in the future without a destructive migration. Validators in the
 * routes guard the set.
 */
export type InsightSeverity = 'info' | 'warning' | 'critical';
export const INSIGHT_SEVERITIES: readonly InsightSeverity[] = [
  'info',
  'warning',
  'critical',
] as const;

export type InsightStatus = 'open' | 'dismissed' | 'resolved';
export const INSIGHT_STATUSES: readonly InsightStatus[] = [
  'open',
  'dismissed',
  'resolved',
] as const;

/**
 * Detector-driven insight type. Add new values here in lock-step with new
 * detector implementations. Stored as STRING so we can extend without a
 * migration.
 *
 * Future AI review (#210) reuses this table via `type: 'ai_review'` (not
 * implemented in this PR) — keep the column wide enough to absorb new values.
 */
export type InsightType =
  | 'duplicate_transactions'
  | 'merchant_spend_spike'
  | 'recurring_increase'
  | 'subscription_price_increase'
  | 'missing_receipt'
  | 'unusual_category_spend'
  | 'settlement_imbalance';

export class Insight extends Model<
  InferAttributes<Insight>,
  InferCreationAttributes<Insight>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare userId: number | null;
  declare type: InsightType;
  declare severity: CreationOptional<InsightSeverity>;
  declare title: string;
  declare description: string | null;
  declare entityType: string | null;
  declare entityId: number | null;
  declare status: CreationOptional<InsightStatus>;
  /**
   * Stable per-insight identifier used to make repeat detector runs
   * idempotent. Detector constructs from the conceptually-unique inputs (e.g.
   * sorted transaction ids + month bucket) so re-running the detector won't
   * create duplicate rows for the same logical finding.
   */
  declare fingerprint: string;
  declare metadata: unknown;
  declare detectedAt: Date;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initInsight(sequelize: Sequelize): typeof Insight {
  Insight.init(
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
      type: { type: DataTypes.STRING(64), allowNull: false },
      severity: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'info',
      },
      title: { type: DataTypes.STRING(255), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      entityType: {
        type: DataTypes.STRING(64),
        field: 'entity_type',
        allowNull: true,
      },
      entityId: {
        type: DataTypes.INTEGER,
        field: 'entity_id',
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'open',
      },
      fingerprint: { type: DataTypes.STRING(128), allowNull: false },
      metadata: { type: DataTypes.JSON, allowNull: true },
      detectedAt: {
        type: DataTypes.DATE,
        field: 'detected_at',
        allowNull: false,
      },
    } as ModelAttributes<Insight>,
    {
      sequelize,
      modelName: 'Insight',
      tableName: 'insights',
      underscored: true,
      timestamps: true,
    }
  );
  return Insight;
}
