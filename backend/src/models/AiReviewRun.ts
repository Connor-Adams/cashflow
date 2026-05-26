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
 * AI finance review status. STRING(32) so we can add async states
 * (e.g. 'queued', 'in_progress') later without a destructive migration.
 */
export type AiReviewRunStatus = 'pending' | 'completed' | 'failed';

export const AI_REVIEW_RUN_STATUSES: readonly AiReviewRunStatus[] = [
  'pending',
  'completed',
  'failed',
] as const;

/**
 * Categories of action items a review can produce. STRING(32) on disk;
 * runtime validation here ensures we surface unknown types as the catch-all
 * 'other' rather than corrupt the inbox UI.
 */
export type AiReviewActionItemType =
  | 'anomaly'
  | 'rule_suggestion'
  | 'missing_receipt'
  | 'subscription'
  | 'forecast_warning'
  | 'other';

export const AI_REVIEW_ACTION_ITEM_TYPES: readonly AiReviewActionItemType[] = [
  'anomaly',
  'rule_suggestion',
  'missing_receipt',
  'subscription',
  'forecast_warning',
  'other',
] as const;

/**
 * Reference target for an action item. 'transaction' | 'event' | 'rule' map
 * to existing rows in transactions, planned_events, rules. When the item
 * isn't tied to a row (e.g. a generic anomaly), refType is null.
 */
export type AiReviewActionItemRefType =
  | 'transaction'
  | 'event'
  | 'rule'
  | null;

export type AiReviewActionItemStatus = 'suggested' | 'accepted' | 'dismissed';

export const AI_REVIEW_ACTION_ITEM_STATUSES: readonly AiReviewActionItemStatus[] = [
  'suggested',
  'accepted',
  'dismissed',
] as const;

export type AiReviewActionItemSeverity = 'info' | 'watch' | 'action';

/**
 * One generated action item inside a review run. Stored inside the JSON
 * `action_items` column. `id` is a UUID/short string assigned at generation
 * so the frontend can refer to it through accept/dismiss without needing
 * its index in the array.
 */
export interface AiReviewActionItem {
  id: string;
  type: AiReviewActionItemType;
  refType: AiReviewActionItemRefType;
  refId: number | null;
  severity: AiReviewActionItemSeverity;
  title: string;
  summary: string;
  status: AiReviewActionItemStatus;
  /** Optional supporting transaction ids (mirrors AiFinancialInsight). */
  supportingTransactionIds?: number[];
  /** Optional rationale string for transparency. */
  rationale?: string;
}

export class AiReviewRun extends Model<
  InferAttributes<AiReviewRun>,
  InferCreationAttributes<AiReviewRun>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare userId: number;
  /** YYYY-MM-DD (DATEONLY). */
  declare periodStart: string;
  /** YYYY-MM-DD (DATEONLY). */
  declare periodEnd: string;
  declare currency: CreationOptional<string>;
  declare status: CreationOptional<AiReviewRunStatus>;
  declare summary: string | null;
  declare actionItems: CreationOptional<AiReviewActionItem[]>;
  declare model: string | null;
  declare promptVersion: string | null;
  declare errorMessage: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initAiReviewRun(sequelize: Sequelize): typeof AiReviewRun {
  AiReviewRun.init(
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
    } as ModelAttributes<AiReviewRun>,
    {
      sequelize,
      modelName: 'AiReviewRun',
      tableName: 'ai_review_runs',
      underscored: true,
      timestamps: true,
    }
  );
  return AiReviewRun;
}
