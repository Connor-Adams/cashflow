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
 * Per-transaction sidecar with return-window and warranty metadata. 1:1 with
 * `transactions` (`transaction_id` is the primary key). Stored separately
 * because most rows don't carry return/warranty info; keeping nullable cols
 * off the hot transactions table avoids row-cache bloat.
 *
 * Receipt-status vocabulary:
 *   'unknown'    — default (user hasn't classified)
 *   'have'       — user has the receipt (paper or attached digitally)
 *   'missing'    — user flagged it as missing
 *   'not_needed' — small purchase / out of return window / no warranty
 */
export const RECEIPT_STATUSES = [
  'unknown',
  'have',
  'missing',
  'not_needed',
] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

export class TransactionReturnMetadata extends Model<
  InferAttributes<TransactionReturnMetadata>,
  InferCreationAttributes<TransactionReturnMetadata>
> {
  declare transactionId: number;
  /** DATEONLY — ISO date string when the return window closes. Null = unset. */
  declare returnDeadline: string | null;
  /** DATEONLY — ISO date string when the warranty coverage ends. Null = unset. */
  declare warrantyEndDate: string | null;
  /** Free-form user notes about the return/warranty situation. */
  declare notes: string | null;
  declare receiptStatus: CreationOptional<ReceiptStatus>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initTransactionReturnMetadata(
  sequelize: Sequelize,
): typeof TransactionReturnMetadata {
  TransactionReturnMetadata.init(
    {
      transactionId: {
        type: DataTypes.INTEGER,
        field: 'transaction_id',
        primaryKey: true,
        allowNull: false,
      },
      returnDeadline: {
        type: DataTypes.DATEONLY,
        field: 'return_deadline',
        allowNull: true,
      },
      warrantyEndDate: {
        type: DataTypes.DATEONLY,
        field: 'warranty_end_date',
        allowNull: true,
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      receiptStatus: {
        type: DataTypes.STRING(16),
        field: 'receipt_status',
        allowNull: false,
        defaultValue: 'unknown',
      },
    } as ModelAttributes<TransactionReturnMetadata>,
    {
      sequelize,
      modelName: 'TransactionReturnMetadata',
      tableName: 'transaction_return_metadata',
      underscored: true,
      timestamps: true,
    },
  );
  return TransactionReturnMetadata;
}
