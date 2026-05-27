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
 * Purchase intelligence sidecar (issue #218). 1:1 with `transactions` via
 * `transaction_id` PK. Stored separately because most transactions never
 * become tracked purchases — keeping the nullable lifecycle columns out of
 * the hot transactions table avoids ballooning the per-row cache footprint.
 *
 * `receiptStatus` / `warrantyStatus` are stored as STRING(16) (not native
 * enums) so the value vocab can grow without a destructive migration.
 * Routes validate against the constants below.
 */
export type PurchaseReceiptStatus = 'unknown' | 'missing' | 'saved';
export const PURCHASE_RECEIPT_STATUSES: readonly PurchaseReceiptStatus[] = [
  'unknown',
  'missing',
  'saved',
] as const;

export type PurchaseWarrantyStatus = 'unknown' | 'none' | 'active' | 'expired';
export const PURCHASE_WARRANTY_STATUSES: readonly PurchaseWarrantyStatus[] = [
  'unknown',
  'none',
  'active',
  'expired',
] as const;

export class Purchase extends Model<
  InferAttributes<Purchase>,
  InferCreationAttributes<Purchase>
> {
  declare transactionId: number;
  declare householdId: number;
  declare markedAt: CreationOptional<Date>;
  declare markedByUserId: number | null;
  declare receiptStatus: CreationOptional<PurchaseReceiptStatus>;
  declare warrantyStatus: CreationOptional<PurchaseWarrantyStatus>;
  /** YYYY-MM-DD (DATEONLY); null when no warranty or unknown end date. */
  declare warrantyExpiresAt: string | null;
  declare warrantyProvider: string | null;
  declare businessRelevant: CreationOptional<boolean>;
  /** Integer months >= 1; null = use elapsed-months denominator. */
  declare usefulLifeMonths: number | null;
  declare notes: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initPurchase(sequelize: Sequelize): typeof Purchase {
  Purchase.init(
    {
      transactionId: {
        type: DataTypes.INTEGER,
        field: 'transaction_id',
        primaryKey: true,
        allowNull: false,
      },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      markedAt: {
        type: DataTypes.DATE,
        field: 'marked_at',
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      markedByUserId: {
        type: DataTypes.INTEGER,
        field: 'marked_by_user_id',
        allowNull: true,
      },
      receiptStatus: {
        type: DataTypes.STRING(16),
        field: 'receipt_status',
        allowNull: false,
        defaultValue: 'unknown',
      },
      warrantyStatus: {
        type: DataTypes.STRING(16),
        field: 'warranty_status',
        allowNull: false,
        defaultValue: 'unknown',
      },
      warrantyExpiresAt: {
        type: DataTypes.DATEONLY,
        field: 'warranty_expires_at',
        allowNull: true,
      },
      warrantyProvider: {
        type: DataTypes.STRING(256),
        field: 'warranty_provider',
        allowNull: true,
      },
      businessRelevant: {
        type: DataTypes.BOOLEAN,
        field: 'business_relevant',
        allowNull: false,
        defaultValue: false,
      },
      usefulLifeMonths: {
        type: DataTypes.INTEGER,
        field: 'useful_life_months',
        allowNull: true,
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    } as ModelAttributes<Purchase>,
    {
      sequelize,
      modelName: 'Purchase',
      tableName: 'purchases',
      underscored: true,
      timestamps: true,
    },
  );
  return Purchase;
}
