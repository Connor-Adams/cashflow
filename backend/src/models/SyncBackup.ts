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
 * Audit row recording each backup-export or restore-import (#239).
 *
 * Bundle bytes are not stored — only metadata. See migration
 * `20260605000050-create-sync-backups.js` for the column-level rationale.
 */
export class SyncBackup extends Model<
  InferAttributes<SyncBackup>,
  InferCreationAttributes<SyncBackup>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare userId: number | null;
  declare kind: 'backup' | 'restore';
  declare bundleVersion: number;
  declare schemaVersion: number;
  declare bundleBytes: number;
  declare tableCounts: Record<string, number>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initSyncBackup(sequelize: Sequelize): typeof SyncBackup {
  SyncBackup.init(
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
      userId: {
        type: DataTypes.INTEGER,
        field: 'user_id',
        allowNull: true,
      },
      kind: {
        type: DataTypes.STRING(16),
        allowNull: false,
        validate: {
          isIn: [['backup', 'restore']],
        },
      },
      bundleVersion: {
        type: DataTypes.INTEGER,
        field: 'bundle_version',
        allowNull: false,
      },
      schemaVersion: {
        type: DataTypes.INTEGER,
        field: 'schema_version',
        allowNull: false,
      },
      bundleBytes: {
        type: DataTypes.INTEGER,
        field: 'bundle_bytes',
        allowNull: false,
      },
      tableCounts: {
        type: DataTypes.JSON,
        field: 'table_counts',
        allowNull: false,
      },
    } as ModelAttributes<SyncBackup>,
    {
      sequelize,
      modelName: 'SyncBackup',
      tableName: 'sync_backups',
      underscored: true,
      timestamps: true,
      indexes: [
        {
          name: 'sync_backups_household_created_at',
          fields: ['household_id', 'created_at'],
        },
        {
          name: 'sync_backups_household_kind',
          fields: ['household_id', 'kind'],
        },
      ],
    },
  );
  return SyncBackup;
}
