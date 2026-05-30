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
 * Per-transaction sidecar for large purchase review workflow (issue #244).
 * 1:1 with `transactions` (`transaction_id` is the primary key). Stored
 * separately because most rows don't need a review record — mirrors the
 * `transaction_return_metadata` sidecar pattern.
 *
 * Status vocabulary:
 *   'pending'   — flagged, awaiting user review (default)
 *   'reviewed'  — user completed the checklist and confirmed it's fine
 *   'dismissed' — user explicitly dismissed without full review
 */
export const LARGE_PURCHASE_REVIEW_STATUSES = [
  'pending',
  'reviewed',
  'dismissed',
] as const;
export type LargePurchaseReviewStatus =
  (typeof LARGE_PURCHASE_REVIEW_STATUSES)[number];

export class TransactionLargePurchaseReview extends Model<
  InferAttributes<TransactionLargePurchaseReview>,
  InferCreationAttributes<TransactionLargePurchaseReview>
> {
  declare transactionId: number;
  declare status: CreationOptional<LargePurchaseReviewStatus>;
  /** True once user confirms category assignment is correct. */
  declare categoryConfirmed: CreationOptional<boolean | null>;
  /** True once user assesses whether the purchase is business-relevant. */
  declare businessRelevant: CreationOptional<boolean | null>;
  /** True once user confirms a receipt is on file or not needed. */
  declare receiptConfirmed: CreationOptional<boolean | null>;
  /** True once user confirms warranty tracking has been handled. */
  declare warrantyTracked: CreationOptional<boolean | null>;
  /** True once user confirms reimbursement tracking has been handled. */
  declare reimbursementTracked: CreationOptional<boolean | null>;
  /** Free-form notes about the purchase. */
  declare notes: CreationOptional<string | null>;
  /** DATEONLY — ISO date string when the user completed the review. */
  declare reviewedAt: CreationOptional<string | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initTransactionLargePurchaseReview(
  sequelize: Sequelize,
): typeof TransactionLargePurchaseReview {
  TransactionLargePurchaseReview.init(
    {
      transactionId: {
        type: DataTypes.INTEGER,
        field: 'transaction_id',
        primaryKey: true,
        allowNull: false,
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'pending',
      },
      categoryConfirmed: {
        type: DataTypes.BOOLEAN,
        field: 'category_confirmed',
        allowNull: true,
        defaultValue: null,
      },
      businessRelevant: {
        type: DataTypes.BOOLEAN,
        field: 'business_relevant',
        allowNull: true,
        defaultValue: null,
      },
      receiptConfirmed: {
        type: DataTypes.BOOLEAN,
        field: 'receipt_confirmed',
        allowNull: true,
        defaultValue: null,
      },
      warrantyTracked: {
        type: DataTypes.BOOLEAN,
        field: 'warranty_tracked',
        allowNull: true,
        defaultValue: null,
      },
      reimbursementTracked: {
        type: DataTypes.BOOLEAN,
        field: 'reimbursement_tracked',
        allowNull: true,
        defaultValue: null,
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
        defaultValue: null,
      },
      reviewedAt: {
        type: DataTypes.DATEONLY,
        field: 'reviewed_at',
        allowNull: true,
        defaultValue: null,
      },
    } as ModelAttributes<TransactionLargePurchaseReview>,
    {
      sequelize,
      modelName: 'TransactionLargePurchaseReview',
      tableName: 'transaction_large_purchase_reviews',
      underscored: true,
      timestamps: true,
    },
  );
  return TransactionLargePurchaseReview;
}
