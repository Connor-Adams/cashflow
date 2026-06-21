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
 * Encrypted finance vault document (issue #241).
 *
 * Each row carries the metadata for one stored file. The bytes live in the
 * receipts upload directory (or S3 with a distinct `vault/` key prefix); the
 * row records *how* those bytes are stored so the routes know how to decode
 * them on download (encryption envelope + algorithm + key version).
 *
 * `visibility` follows the same convention as transactions/accounts so the
 * existing `visibleWhere(req)` scope helper filters vault documents
 * consistently (shared docs visible to the whole household, private docs only
 * to the uploader).
 *
 * `linkedEntityType` + `linkedEntityId` are a soft cross-reference. We
 * intentionally avoid a foreign-key constraint here so the set of linkable
 * entities can grow (transaction, merchant, account, tax_year, purchase, …)
 * without a destructive migration.
 */
export type VaultLinkedEntityType =
  | 'transaction'
  | 'merchant'
  | 'account'
  | 'tax_year'
  | 'purchase';

export const VAULT_LINKED_ENTITY_TYPES: readonly VaultLinkedEntityType[] = [
  'transaction',
  'merchant',
  'account',
  'tax_year',
  'purchase',
] as const;

export type VaultStorageKind = 'local' | 's3';

// Same literal union also declared in storage/vaultStorage.ts; intentional domain-local copy to avoid a model->storage import.
export type VaultEncryptionAlgorithm = 'aes-256-gcm' | 'none';

export type VaultVisibility = 'shared' | 'private';
export const VAULT_VISIBILITIES: readonly VaultVisibility[] = [
  'shared',
  'private',
] as const;

export class VaultDocument extends Model<
  InferAttributes<VaultDocument>,
  InferCreationAttributes<VaultDocument>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare uploadedByUserId: number | null;
  declare visibility: CreationOptional<VaultVisibility>;
  declare originalName: string;
  declare mimeType: string;
  declare sizeBytes: number;
  declare storedFilename: string;
  declare storageKind: CreationOptional<VaultStorageKind>;
  declare encryptionAlgorithm: CreationOptional<VaultEncryptionAlgorithm>;
  declare encryptionKeyVersion: CreationOptional<number>;
  declare tags: string[] | null;
  declare linkedEntityType: VaultLinkedEntityType | null;
  declare linkedEntityId: number | null;
  declare description: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initVaultDocument(sequelize: Sequelize): typeof VaultDocument {
  VaultDocument.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      uploadedByUserId: {
        type: DataTypes.INTEGER,
        field: 'uploaded_by_user_id',
        allowNull: true,
      },
      visibility: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'shared',
      },
      originalName: {
        type: DataTypes.STRING(512),
        field: 'original_name',
        allowNull: false,
      },
      mimeType: {
        type: DataTypes.STRING(128),
        field: 'mime_type',
        allowNull: false,
      },
      sizeBytes: {
        type: DataTypes.INTEGER,
        field: 'size_bytes',
        allowNull: false,
      },
      storedFilename: {
        type: DataTypes.STRING(512),
        field: 'stored_filename',
        allowNull: false,
      },
      storageKind: {
        type: DataTypes.STRING(16),
        field: 'storage_kind',
        allowNull: false,
        defaultValue: 'local',
      },
      encryptionAlgorithm: {
        type: DataTypes.STRING(32),
        field: 'encryption_algorithm',
        allowNull: false,
        defaultValue: 'aes-256-gcm',
      },
      encryptionKeyVersion: {
        type: DataTypes.INTEGER,
        field: 'encryption_key_version',
        allowNull: false,
        defaultValue: 1,
      },
      tags: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      linkedEntityType: {
        type: DataTypes.STRING(32),
        field: 'linked_entity_type',
        allowNull: true,
      },
      linkedEntityId: {
        type: DataTypes.INTEGER,
        field: 'linked_entity_id',
        allowNull: true,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    } as ModelAttributes<VaultDocument>,
    {
      sequelize,
      modelName: 'VaultDocument',
      tableName: 'vault_documents',
      underscored: true,
      timestamps: true,
    },
  );
  return VaultDocument;
}
