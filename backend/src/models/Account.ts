import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  Op,
} from 'sequelize';
import { createHash } from 'crypto';
import { logger } from '../observability/logger';
import { encryptSecret, decryptSecret } from '../util/symmetricEncryption';

/**
 * Deterministic sha256 hex of a bank account number, used for the dedup unique
 * index (the encrypted column can't be unique — each encrypt uses a random IV).
 * Exported so callers that dedup by bank number (import accountLookup) compute
 * the same hash without holding plaintext in a query.
 */
export function hashBankAccountNumber(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export type AccountTaxStatus =
  | 'registered_rrsp'
  | 'registered_tfsa'
  | 'registered_fhsa'
  | 'registered_rrif'
  | 'registered_rdsp'
  | 'registered_resp'
  | 'non_registered'
  | 'n_a';

export class Account extends Model<
  InferAttributes<Account>,
  InferCreationAttributes<Account>
> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare owner: string;
  declare householdId: number | null;
  declare ownerUserId: number | null;
  declare visibility: CreationOptional<string>;
  declare accountType: CreationOptional<string>;
  declare shortCode: string | null;
  /**
   * Bank account number. Stored ENCRYPTED at rest (#871): this is a Sequelize
   * VIRTUAL attribute backed by `bank_account_number_encrypted` (AES-256-GCM
   * envelope via symmetricEncryption) plus `bank_account_number_hash`
   * (sha256, for the dedup unique index). Reading decrypts transparently;
   * assigning encrypts + rehashes. Never persisted in plaintext.
   */
  declare bankAccountNumber: string | null;
  declare bankAccountNumberEncrypted: CreationOptional<string | null>;
  declare bankAccountNumberHash: CreationOptional<string | null>;
  declare defaultCurrency: string | null;
  declare entityId: number | null;
  declare taxStatus: CreationOptional<AccountTaxStatus>;
  declare openingBalance: CreationOptional<string>;
  declare openingBalanceDate: CreationOptional<string | null>;
  declare closedAt: CreationOptional<string | null>;
  declare notes: string | null;
  /**
   * Account merge / consolidation (#287). When set, this account is a merged
   * source: its transactions + planned events were reassigned to the target
   * account `mergedIntoId`, and the row is hidden from the default account
   * list. Null for a normal (un-merged) account.
   */
  declare mergedIntoId: CreationOptional<number | null>;
  declare mergedAt: CreationOptional<Date | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initAccount(sequelize: Sequelize): typeof Account {
  Account.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      name: { type: DataTypes.STRING, allowNull: false },
      owner: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'me',
      },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: true,
      },
      ownerUserId: {
        type: DataTypes.INTEGER,
        field: 'owner_user_id',
        allowNull: true,
      },
      visibility: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'private',
      },
      accountType: {
        type: DataTypes.STRING(32),
        field: 'account_type',
        allowNull: false,
        defaultValue: 'checking',
      },
      shortCode: {
        type: DataTypes.STRING(64),
        field: 'short_code',
        allowNull: true,
      },
      // Persisted ciphertext (AES-256-GCM envelope, base64). Never plaintext.
      bankAccountNumberEncrypted: {
        type: DataTypes.TEXT,
        field: 'bank_account_number_encrypted',
        allowNull: true,
      },
      // Deterministic sha256(plaintext) for the dedup unique index. The
      // encrypted column can't be unique (random IV per encrypt), so dedup keys
      // off this hash instead.
      bankAccountNumberHash: {
        type: DataTypes.STRING(64),
        field: 'bank_account_number_hash',
        allowNull: true,
      },
      // VIRTUAL: encrypt-on-write / decrypt-on-read facade over the two columns
      // above. Keeps every existing reader/writer of `bankAccountNumber`
      // working while the value lives encrypted at rest (#871).
      bankAccountNumber: {
        type: DataTypes.VIRTUAL(DataTypes.STRING, [
          'bankAccountNumberEncrypted',
        ]),
        get(this: Account): string | null {
          const enc = this.getDataValue('bankAccountNumberEncrypted');
          if (enc == null) return null;
          return decryptSecret(enc);
        },
        set(this: Account, value: string | null) {
          if (value == null || value === '') {
            this.setDataValue('bankAccountNumberEncrypted', null);
            this.setDataValue('bankAccountNumberHash', null);
            return;
          }
          this.setDataValue('bankAccountNumberEncrypted', encryptSecret(value));
          this.setDataValue('bankAccountNumberHash', hashBankAccountNumber(value));
        },
      },
      defaultCurrency: {
        type: DataTypes.STRING(3),
        field: 'default_currency',
        allowNull: true,
      },
      entityId: {
        type: DataTypes.INTEGER,
        field: 'entity_id',
        allowNull: true,
      },
      taxStatus: {
        type: DataTypes.STRING(32),
        field: 'tax_status',
        allowNull: false,
        defaultValue: 'n_a',
      },
      openingBalance: {
        type: DataTypes.DECIMAL(18, 4),
        field: 'opening_balance',
        allowNull: false,
        defaultValue: 0,
      },
      openingBalanceDate: {
        type: DataTypes.DATEONLY,
        field: 'opening_balance_date',
        allowNull: true,
        defaultValue: null,
      },
      closedAt: {
        type: DataTypes.DATEONLY,
        field: 'closed_at',
        allowNull: true,
        defaultValue: null,
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
        defaultValue: null,
      },
      mergedIntoId: {
        type: DataTypes.INTEGER,
        field: 'merged_into_id',
        allowNull: true,
        defaultValue: null,
      },
      mergedAt: {
        type: DataTypes.DATE,
        field: 'merged_at',
        allowNull: true,
        defaultValue: null,
      },
    } as ModelAttributes<Account>,
    {
      sequelize,
      modelName: 'Account',
      tableName: 'accounts',
      underscored: true,
      timestamps: true,
      indexes: [
        {
          // Dedup: one bank account number per household. Keyed off the sha256
          // hash because the encrypted column varies per-encrypt (random IV).
          // Mirrors migration 20260626000001 (#871).
          name: 'accounts_household_bank_number_hash_unique',
          unique: true,
          fields: ['household_id', 'bank_account_number_hash'],
          where: { bank_account_number_hash: { [Op.ne]: null } },
        },
      ],
    }
  );

  /**
   * Default entity_id to the household's `personal` tax entity when not
   * explicitly set. Accounts created with NULL entity_id are silently excluded
   * from the T1/T2 tax engine (buildPersonalFacts / buildCorpFacts both query
   * `where entityId=...`), so every account must carry one. Explicit tagging
   * (e.g. a corp account from the PDF importer) wins because we only fill when
   * null. Accounts without a household have no entity to default to and are
   * left unset. Lazy import dodges the model<->service circular dependency at
   * init time.
   */
  const fillPersonalEntity = async (
    instance: Account,
    options: { transaction?: import('sequelize').Transaction },
  ): Promise<void> => {
    if (instance.entityId != null || instance.householdId == null) return;
    try {
      const { getOrCreatePersonalEntity } = await import(
        '../tax/services/getOrCreatePersonalEntity'
      );
      const personal = await getOrCreatePersonalEntity(instance.householdId, {
        transaction: options.transaction,
      });
      instance.entityId = personal.id;
    } catch (e) {
      // Best-effort: a missing household row (orphaned/legacy data) makes the
      // personal-entity FK insert fail. Never break account creation over it —
      // leave entity_id null; syncTransactionEntityIds / a later create can
      // backfill once the household exists.
      logger.warn({ err: e, householdId: instance.householdId, model: 'Account' }, 'fill_personal_entity_failed');
    }
  };
  Account.addHook('beforeCreate', fillPersonalEntity);
  Account.addHook('beforeBulkCreate', async (instances, options) => {
    for (const instance of instances as Account[]) {
      await fillPersonalEntity(
        instance,
        options as { transaction?: import('sequelize').Transaction },
      );
    }
  });

  /**
   * Default an investment account's tax_status from its name when left at the
   * 'n_a' default. Registered accounts (TFSA/FHSA/RRSP/RRIF/RDSP) MUST carry a
   * registered_* status or buildPersonalFacts' taxable allowlist
   * ('non_registered','n_a') lets their sheltered in-account income/gains leak
   * onto the personal T1. Only fills the default — an explicit tax_status wins.
   * Non-investment accounts keep 'n_a'. Lazy import keeps the model free of a
   * service-layer dependency at init time.
   */
  const fillInvestmentTaxStatus = async (instance: Account): Promise<void> => {
    if (instance.accountType !== 'investment') return;
    if (instance.taxStatus != null && instance.taxStatus !== 'n_a') return;
    try {
      const { inferTaxStatus } = await import('../tax/services/inferTaxStatus');
      instance.taxStatus = inferTaxStatus(instance.name);
    } catch (e) {
      logger.warn({ err: e, model: 'Account' }, 'fill_investment_tax_status_failed');
    }
  };
  Account.addHook('beforeCreate', fillInvestmentTaxStatus);
  Account.addHook('beforeBulkCreate', async (instances) => {
    for (const instance of instances as Account[]) {
      await fillInvestmentTaxStatus(instance);
    }
  });

  return Account;
}
