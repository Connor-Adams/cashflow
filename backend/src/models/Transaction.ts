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
import { TRANSACTION_STATUSES, type TransactionStatus } from '../transactions/types';

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
  declare status: CreationOptional<TransactionStatus>;
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
  declare autoCategoryId: number | null;
  declare categoryOverrideId: number | null;
  declare finalCategoryId: number | null;
  declare taxTreatmentOverride: string | null;

  declare counterpartyRaw: string | null;
  declare counterpartyContactId: number | null;

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

  /**
   * Deterministic post-import confidence state assigned by
   * computeImportConfidence (#214). NULL on legacy rows that predate the
   * classifier — aggregator treats NULL as "unknown" so backfill is
   * incremental. One of 'clean' | 'needs_review' when populated.
   */
  declare importConfidence: string | null;
  /**
   * JSON-encoded array of import-confidence flag tokens (e.g.
   * ["missing_category", "needs_review"]). NULL when no flags fired.
   * Stored as TEXT for SQLite-compat in migration round-trip tests.
   */
  declare importConfidenceFlags: string | null;

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
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'posted',
        validate: {
          isIn: [TRANSACTION_STATUSES],
        },
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
      autoCategoryId: {
        type: DataTypes.INTEGER,
        field: 'auto_category_id',
        allowNull: true,
      },
      categoryOverrideId: {
        type: DataTypes.INTEGER,
        field: 'category_override_id',
        allowNull: true,
      },
      finalCategoryId: {
        type: DataTypes.INTEGER,
        field: 'final_category_id',
        allowNull: true,
      },
      taxTreatmentOverride: {
        type: DataTypes.STRING(32),
        field: 'tax_treatment_override',
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

      importConfidence: {
        type: DataTypes.STRING(16),
        field: 'import_confidence',
        allowNull: true,
      },
      importConfidenceFlags: {
        type: DataTypes.TEXT,
        field: 'import_confidence_flags',
        allowNull: true,
      },

      counterpartyRaw: {
        type: DataTypes.TEXT,
        field: 'counterparty_raw',
        allowNull: true,
      },
      counterpartyContactId: {
        type: DataTypes.INTEGER,
        field: 'counterparty_contact_id',
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
  Transaction.addHook('beforeSave', async (instance: Transaction, options) => {
    if (instance.householdId == null) return;
    const { resolveCategoryIdByName } = await import('../categories/resolveCategoryId');
    const tx = options.transaction ?? undefined;
    instance.autoCategoryId = await resolveCategoryIdByName(instance.householdId, instance.autoCategory, { transaction: tx });
    instance.categoryOverrideId = await resolveCategoryIdByName(instance.householdId, instance.categoryOverride, { transaction: tx });
    instance.finalCategoryId = await resolveCategoryIdByName(instance.householdId, instance.finalCategory, { transaction: tx });
  });

  /**
   * Version-history capture (#229). Computed in `beforeUpdate` so
   * `previous(field)` still returns the pre-mutation value (after
   * `afterUpdate`, Sequelize has synced the snapshot and the diff is
   * lost). The diff is stashed on the `options` bag and consumed by the
   * `afterUpdate` hook below, which writes a single TransactionRevision
   * row inside the caller's SQL transaction (if any).
   *
   * No revision is written when nothing tracked changed — the recorder
   * returns `null` from buildTransactionDiff in that case.
   */
  Transaction.addHook('beforeUpdate', (instance: Transaction, options) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { buildTransactionDiff } = require('../util/transactionRevisions') as typeof import('../util/transactionRevisions');
      const diff = buildTransactionDiff(instance);
      if (diff != null) {
        (options as unknown as { _pendingRevisionDiff?: unknown })._pendingRevisionDiff = diff;
      }
    } catch (e) {
      logger.warn({ err: e, model: 'Transaction' }, 'transaction_revision_diff_failed');
    }
  });
  Transaction.addHook('afterUpdate', async (instance: Transaction, options) => {
    const opts = options as unknown as {
      _pendingRevisionDiff?: Array<{ field: string; before: unknown; after: unknown }>;
    };
    const diff = opts._pendingRevisionDiff;
    if (!diff || diff.length === 0) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { recordTransactionRevision } = require('../util/transactionRevisions') as typeof import('../util/transactionRevisions');
      await recordTransactionRevision(instance, diff, {
        transaction: options.transaction,
      });
    } catch (e) {
      logger.warn(
        { err: e, model: 'Transaction', transactionId: instance.id },
        'transaction_revision_record_failed',
      );
    } finally {
      // Clear so a subsequent reload-then-save in the same options bag
      // doesn't accidentally re-emit the same revision.
      delete opts._pendingRevisionDiff;
    }
  });

  /**
   * Inherit entity_id from the owning account when not explicitly set. The tax
   * engine keys income off transactions.entity_id (buildPersonalFacts /
   * buildCorpFacts use `where entityId=...`), so a NULL-entity transaction is
   * silently dropped from T1/T2 even when its account is correctly tagged.
   * Mirroring the account's entity at insert time keeps the invariant
   * (a txn's entity == its account's entity) without a DB trigger. Lazy import
   * of Account dodges init-order coupling.
   */
  const inheritEntityFromAccount = async (
    instance: Transaction,
    options: { transaction?: import('sequelize').Transaction },
  ): Promise<void> => {
    if (instance.entityId != null || instance.accountId == null) return;
    try {
      const { Account } = await import('./Account');
      const account = await Account.findByPk(instance.accountId, {
        attributes: ['id', 'entityId'],
        transaction: options.transaction,
      });
      if (account?.entityId != null) {
        instance.entityId = account.entityId;
      }
    } catch (e) {
      // Best-effort: never break transaction creation if the account lookup
      // fails. Leave entity_id null; syncTransactionEntityIds backfills later.
      logger.warn({ err: e, accountId: instance.accountId, model: 'Transaction' }, 'inherit_entity_from_account_failed');
    }
  };
  Transaction.addHook('beforeCreate', inheritEntityFromAccount);
  Transaction.addHook('beforeBulkCreate', async (instances, options) => {
    for (const instance of instances as Transaction[]) {
      await inheritEntityFromAccount(
        instance,
        options as { transaction?: import('sequelize').Transaction },
      );
    }
  });

  return Transaction;
}
