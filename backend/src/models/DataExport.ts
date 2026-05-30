import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export type DataExportStatus = 'queued' | 'running' | 'ready' | 'failed';

/**
 * User data export (issue #302). Each row tracks one export request from
 * a user — its lifecycle status (queued → running → ready | failed), the
 * storage path of the generated archive, and its expiry time.
 *
 * Scoped to user_id so callers can never read another user's export.
 * No household FK: exports are per-user, not per-household, so the
 * user can retrieve their own data after leaving a household.
 */
export class DataExport extends Model<
  InferAttributes<DataExport>,
  InferCreationAttributes<DataExport>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  /** Status machine: queued → running → ready | failed */
  declare status: DataExportStatus;
  declare requestedAt: Date;
  declare readyAt: Date | null;
  declare expiresAt: Date | null;
  /** Filesystem path relative to STORAGE_DIR, e.g. "exports/{id}.json.gz" */
  declare storageKey: string | null;
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
