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
 * CFO briefing (issue #236).
 *
 * A daily/weekly finance assistant snapshot that combines deterministic
 * action items from across the app (forecast, safe-to-spend, subscriptions,
 * receipts, imports, rules, review backlog) into one self-contained record.
 *
 * Sibling concept of {@link AiReviewRun} (#210, monthly review) but
 * intentionally distinct: smaller default window, adds a safe-to-spend
 * headline snapshot, uses 'open|resolved|dismissed' for item lifecycle
 * (vs 'suggested|accepted|dismissed' on review runs).
 */
export type CfoBriefingStatus = 'pending' | 'completed' | 'failed';

/**
 * Categories of action items a briefing can surface. Persisted as STRING
 * inside the JSON column; runtime validation here ensures unknown types
 * fall back to 'other' rather than break the briefing page.
 */
export type CfoBriefingActionItemType =
  | 'forecast_warning'
  | 'safe_to_spend_low'
  | 'missing_receipt'
  | 'new_subscription'
  | 'rule_suggestion'
  | 'review_backlog'
  | 'import_issue'
  | 'anomaly'
  | 'other';

export type CfoBriefingActionItemRefType =
  | 'transaction'
  | 'event'
  | 'rule'
  | 'subscription'
  | 'import'
  | null;

export type CfoBriefingActionItemStatus = 'open' | 'resolved' | 'dismissed';

export const CFO_BRIEFING_ACTION_ITEM_STATUSES: readonly CfoBriefingActionItemStatus[] = [
  'open',
  'resolved',
  'dismissed',
] as const;

export type CfoBriefingActionItemSeverity = 'info' | 'watch' | 'action';

/**
 * One action item inside a briefing run. Stored inside the JSON
 * `action_items` column. `id` is a stable string per item so the frontend
 * can refer to it through resolve/dismiss endpoints without indices.
 *
 * `link` is a frontend-renderable path the action item links to (e.g.
 * '/transactions/42'). Required by issue #236 AC: "Briefing includes
 * actionable items with links."
 */
export interface CfoBriefingActionItem {
  id: string;
  type: CfoBriefingActionItemType;
  refType: CfoBriefingActionItemRefType;
  refId: number | null;
  severity: CfoBriefingActionItemSeverity;
  title: string;
  summary: string;
  status: CfoBriefingActionItemStatus;
  /** Optional supporting transaction ids (mirrors AiFinancialInsight). */
  supportingTransactionIds?: number[];
  /** Optional rationale string for transparency / "no invented facts" AC. */
  rationale?: string;
  /** Optional frontend route to the cleanup workflow. */
  link?: string;
}

/**
 * Compact safe-to-spend snapshot stored on the briefing for the headline.
 * Subset of {@link import('../cashflow/safeToSpend').SafeToSpendResult} —
 * we don't need the full breakdown for the briefing page, just the
 * headline + the value/sign/window.
 */
export interface CfoBriefingSafeToSpendSnapshot {
  value: number;
  currency: string;
  isNegative: boolean;
  windowDays: number;
  windowEndDate: string;
  asOfDate: string;
}

export class CfoBriefing extends Model<
  InferAttributes<CfoBriefing>,
  InferCreationAttributes<CfoBriefing>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare userId: number;
  /** YYYY-MM-DD (DATEONLY). */
  declare periodStart: string;
  /** YYYY-MM-DD (DATEONLY). */
  declare periodEnd: string;
  declare currency: CreationOptional<string>;
  declare status: CreationOptional<CfoBriefingStatus>;
  declare summary: string | null;
  declare actionItems: CreationOptional<CfoBriefingActionItem[]>;
  declare safeToSpendSnapshot: CreationOptional<CfoBriefingSafeToSpendSnapshot | null>;
  declare model: string | null;
  declare promptVersion: string | null;
  declare errorMessage: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initCfoBriefing(sequelize: Sequelize): typeof CfoBriefing {
  CfoBriefing.init(
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
      periodStart: {
        type: DataTypes.DATEONLY,
        field: 'period_start',
        allowNull: false,
      },
      periodEnd: {
        type: DataTypes.DATEONLY,
        field: 'period_end',
        allowNull: false,
      },
      currency: {
        type: DataTypes.STRING(3),
        allowNull: false,
        defaultValue: 'CAD',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'completed',
      },
      summary: { type: DataTypes.TEXT, allowNull: true },
      actionItems: {
        type: DataTypes.JSON,
        field: 'action_items',
        allowNull: false,
        defaultValue: [],
      },
      safeToSpendSnapshot: {
        type: DataTypes.JSON,
        field: 'safe_to_spend_snapshot',
        allowNull: true,
      },
      model: { type: DataTypes.STRING(128), allowNull: true },
      promptVersion: {
        type: DataTypes.STRING(64),
        field: 'prompt_version',
        allowNull: true,
      },
      errorMessage: {
        type: DataTypes.TEXT,
        field: 'error_message',
        allowNull: true,
      },
    } as ModelAttributes<CfoBriefing>,
    {
      sequelize,
      modelName: 'CfoBriefing',
      tableName: 'cfo_briefings',
      underscored: true,
      timestamps: true,
    }
  );
  return CfoBriefing;
}
