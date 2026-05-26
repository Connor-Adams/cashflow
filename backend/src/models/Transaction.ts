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

export class Transaction extends Model<
  InferAttributes<Transaction>,
  InferCreationAttributes<Transaction>
> {
  declare id: CreationOptional<number>;
  declare accountId: number;
  declare householdId: number | null;
  declare createdByUserId: number | null;
  declare visibility: CreationOptional<string>;
  declare ownershipType: CreationOptional<string>;
  declare ownershipContactId: number | null;
  declare importBatch: string;
  /** DATEONLY — ISO date string */
  declare date: string;
  declare merchantRaw: string;
  declare merchantClean: string;
  declare amount: string;
  declare currency: string;
  declare notes: string | null;
  declare sourceReference: string | null;
  declare sourceRowFingerprint: string;
  declare sourceIdentityFingerprint: string;
  declare appliedRuleId: number | null;
  declare entityId: number | null;

  declare merchantCanonical: string | null;
  declare txnType: CreationOptional<string>;
  declare autoSource: string | null;
  declare autoConfidence: string | null;
  declare linkedTransactionId: number | null;
  declare transferPurpose: string | null;
  declare transferLinkedAt: Date | null;
  declare isRecurring: CreationOptional<boolean>;

  declare autoCategory: string | null;
  declare categoryOverride: string | null;
  declare finalCategory: string | null;

  declare autoBusiness: boolean | null;
  declare businessOverride: boolean | null;
  declare finalBusiness: CreationOptional<boolean>;

  declare autoSplitType: string | null;
  declare splitOverride: string | null;
  declare finalSplitType: CreationOptional<string>;

  declare autoPctMe: string | null;
  declare pctMeOverride: string | null;
  declare finalPctMe: string | null;

  declare autoPctPartner: string | null;
  declare pctPartnerOverride: string | null;
  declare finalPctPartner: string | null;

  declare myShareAmount: CreationOptional<string>;
  declare partnerShareAmount: CreationOptional<string>;
  declare businessAmount: CreationOptional<string>;

  declare reviewFlag: boolean;
  declare reviewedAt: Date | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initTransaction(sequelize: Sequelize): typeof Transaction {
  Transaction.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      accountId: {
        type: DataTypes.INTEGER,
        field: 'account_id',
        allowNull: false,
      },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: true,
      },
      createdByUserId: {
        type: DataTypes.INTEGER,
        field: 'created_by_user_id',
        allowNull: true,
      },
      visibility: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'private',
      },
      ownershipType: {
        type: DataTypes.STRING(16),
        field: 'ownership_type',
        allowNull: false,
        defaultValue: 'me',
      },
      ownershipContactId: {
        type: DataTypes.INTEGER,
        field: 'ownership_contact_id',
        allowNull: true,
      },
      importBatch: {
        type: DataTypes.STRING(128),
        field: 'import_batch',
        allowNull: false,
      },
      date: { type: DataTypes.DATEONLY, allowNull: false },
      merchantRaw: {
        type: DataTypes.STRING(1024),
        field: 'merchant_raw',
        allowNull: false,
      },
      merchantClean: {
        type: DataTypes.STRING(1024),
        field: 'merchant_clean',
        allowNull: false,
      },
      amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      notes: { type: DataTypes.TEXT, allowNull: true },
      sourceReference: {
        type: DataTypes.STRING(256),
        field: 'source_reference',
        allowNull: true,
      },
      sourceRowFingerprint: {
        type: DataTypes.STRING(128),
        field: 'source_row_fingerprint',
        allowNull: false,
      },
      sourceIdentityFingerprint: {
        type: DataTypes.STRING(128),
        field: 'source_identity_fingerprint',
        allowNull: false,
      },
      appliedRuleId: {
        type: DataTypes.INTEGER,
        field: 'applied_rule_id',
        allowNull: true,
      },
      entityId: {
        type: DataTypes.INTEGER,
        field: 'entity_id',
        allowNull: true,
      },

      autoCategory: {
        type: DataTypes.STRING(128),
        field: 'auto_category',
        allowNull: true,
      },
      categoryOverride: {
        type: DataTypes.STRING(128),
        field: 'category_override',
        allowNull: true,
      },
      finalCategory: {
        type: DataTypes.STRING(128),
        field: 'final_category',
        allowNull: true,
      },

      autoBusiness: {
        type: DataTypes.BOOLEAN,
        field: 'auto_business',
        allowNull: true,
      },
      businessOverride: {
        type: DataTypes.BOOLEAN,
        field: 'business_override',
        allowNull: true,
      },
      finalBusiness: {
        type: DataTypes.BOOLEAN,
        field: 'final_business',
        allowNull: false,
        defaultValue: false,
      },

      autoSplitType: {
        type: DataTypes.STRING(16),
        field: 'auto_split_type',
        allowNull: true,
      },
      splitOverride: {
        type: DataTypes.STRING(16),
        field: 'split_override',
        allowNull: true,
      },
      finalSplitType: {
        type: DataTypes.STRING(16),
        field: 'final_split_type',
        allowNull: false,
        defaultValue: 'me',
      },

      autoPctMe: {
        type: DataTypes.DECIMAL(5, 4),
        field: 'auto_pct_me',
        allowNull: true,
      },
      pctMeOverride: {
        type: DataTypes.DECIMAL(5, 4),
        field: 'pct_me_override',
        allowNull: true,
      },
      finalPctMe: {
        type: DataTypes.DECIMAL(5, 4),
        field: 'final_pct_me',
        allowNull: true,
      },

      autoPctPartner: {
        type: DataTypes.DECIMAL(5, 4),
        field: 'auto_pct_partner',
        allowNull: true,
      },
      pctPartnerOverride: {
        type: DataTypes.DECIMAL(5, 4),
        field: 'pct_partner_override',
        allowNull: true,
      },
      finalPctPartner: {
        type: DataTypes.DECIMAL(5, 4),
        field: 'final_pct_partner',
        allowNull: true,
      },

      myShareAmount: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'my_share_amount',
        allowNull: false,
        defaultValue: 0,
      },
      partnerShareAmount: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'partner_share_amount',
        allowNull: false,
        defaultValue: 0,
      },
      businessAmount: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'business_amount',
        allowNull: false,
        defaultValue: 0,
      },

      merchantCanonical: {
        type: DataTypes.STRING(256),
        field: 'merchant_canonical',
        allowNull: true,
      },
      txnType: {
        type: DataTypes.STRING(16),
        field: 'txn_type',
        allowNull: false,
        defaultValue: 'purchase',
      },
      autoSource: {
        type: DataTypes.STRING(32),
        field: 'auto_source',
        allowNull: true,
      },
      autoConfidence: {
        type: DataTypes.STRING(8),
        field: 'auto_confidence',
        allowNull: true,
      },
      linkedTransactionId: {
        type: DataTypes.INTEGER,
        field: 'linked_transaction_id',
        allowNull: true,
      },
      transferPurpose: {
        type: DataTypes.STRING(32),
        field: 'transfer_purpose',
        allowNull: true,
      },
      transferLinkedAt: {
        type: DataTypes.DATE,
        field: 'transfer_linked_at',
        allowNull: true,
      },
      isRecurring: {
        type: DataTypes.BOOLEAN,
        field: 'is_recurring',
        allowNull: false,
        defaultValue: false,
      },

      reviewFlag: {
        type: DataTypes.BOOLEAN,
        field: 'review_flag',
        allowNull: false,
        defaultValue: false,
      },
      reviewedAt: {
        type: DataTypes.DATE,
        field: 'reviewed_at',
        allowNull: true,
      },
    } as ModelAttributes<Transaction>,
    {
      sequelize,
      modelName: 'Transaction',
      tableName: 'transactions',
      underscored: true,
      timestamps: true,
    }
  );
  Transaction.addHook('afterSave', async (instance: Transaction, options) => {
    if (instance.householdId == null) return;
    try {
      const { ensureCategory } = await import('../util/ensureCategory');
      await ensureCategory(instance.householdId, instance.finalCategory, {
        transaction: options.transaction,
      });
    } catch (e) {
      logger.warn({ err: e, model: 'Transaction' }, 'ensure_category_hook_failed');
    }
  });
  return Transaction;
}
