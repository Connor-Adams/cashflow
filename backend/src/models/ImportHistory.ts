import type { Sequelize } from 'sequelize';
import { DataTypes } from 'sequelize';

export default function defineImportHistory(sequelize: Sequelize) {
  return sequelize.define(
    'ImportHistory',
    {
      fileName: {
        type: DataTypes.STRING(512),
        field: 'file_name',
        allowNull: false,
      },
      filePathSafe: {
        type: DataTypes.STRING(1024),
        field: 'file_path_safe',
        allowNull: false,
      },
      contentHash: {
        type: DataTypes.STRING(64),
        field: 'content_hash',
        allowNull: false,
      },
      batchLabel: {
        type: DataTypes.STRING(256),
        field: 'batch_label',
        allowNull: false,
      },
      status: { type: DataTypes.STRING(32), allowNull: false },
      rowCount: { type: DataTypes.INTEGER, field: 'row_count', allowNull: true },
      errorMessage: {
        type: DataTypes.TEXT,
        field: 'error_message',
        allowNull: true,
      },
      startedAt: {
        type: DataTypes.DATE,
        field: 'started_at',
        allowNull: false,
      },
      finishedAt: {
        type: DataTypes.DATE,
        field: 'finished_at',
        allowNull: true,
      },
    },
    {
      tableName: 'import_histories',
      underscored: true,
      timestamps: true,
    }
  );
}
