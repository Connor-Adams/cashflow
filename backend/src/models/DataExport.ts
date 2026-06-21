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
 * Lifecycle statuses for a data export job.
 * Stored as STRING(16) so the vocabulary can grow without a destructive
 * migration (same pattern as Reimbursement.status).
 */
export const DATA_EXPORT_STATUSES = ['queued', 'running', 'ready', 'failed'] as const;
export type DataExportStatus = (typeof DATA_EXPORT_STATUSES)[number];

/**
 * DataExport model (issue #302).
 *
 * One row per user-requested full-data export ZIP. The background job
 * `userDataExport` writes JSON dumps for every model, packages them into
 * a ZIP, saves it under STORAGE_DIR/exports/<userId>/<id>.zip, and updates
 * `storage_key`, `byte_size`, `ready_at`, and `expires_at` on success.
 *
 * `expires_at` is set to `ready_at + 7 days`; the nightly cron
 * `dataExportCleanup` removes the physical file and marks the row.
 */
export class DataExport extends Model<
  InferAttributes<DataExport>,
  InferCreationAttributes<DataExport>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare status: CreationOptional<DataExportStatus>;
  declare requestedAt: CreationOptional<Date>;
  declare readyAt: Date | null;
  declare expiresAt: Date | null;
  /** Relative path under STORAGE_DIR/exports/ or object-storage key. */
  declare storageKey: string | null;
  /** Byte size of the ZIP file, set on success. */
  declare byteSize: number | null;
  declare errorMessage: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initDataExport(sequelize: Sequelize): typeof DataExport {
  DataExport.init(
    {
      id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
      userId: {
        type: DataTypes.BIGINT,
        field: 'user_id',
        allowNull: false,
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'queued',
      },
      requestedAt: {
        type: DataTypes.DATE,
        field: 'requested_at',
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      readyAt: {
        type: DataTypes.DATE,
        field: 'ready_at',
        allowNull: true,
      },
      expiresAt: {
        type: DataTypes.DATE,
        field: 'expires_at',
        allowNull: true,
      },
      storageKey: {
        type: DataTypes.STRING(256),
        field: 'storage_key',
        allowNull: true,
      },
      byteSize: {
        type: DataTypes.BIGINT,
        field: 'byte_size',
        allowNull: true,
      },
      errorMessage: {
        type: DataTypes.TEXT,
        field: 'error_message',
        allowNull: true,
      },
    } as ModelAttributes<DataExport>,
    {
      sequelize,
      modelName: 'DataExport',
      tableName: 'data_exports',
      underscored: true,
      timestamps: true,
    },
  );
  return DataExport;
}
