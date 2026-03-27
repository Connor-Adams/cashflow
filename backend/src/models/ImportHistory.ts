import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class ImportHistory extends Model<
  InferAttributes<ImportHistory>,
  InferCreationAttributes<ImportHistory>
> {
  declare id: CreationOptional<number>;
  declare fileName: string;
  declare filePathSafe: string;
  declare contentHash: string;
  declare batchLabel: string;
  declare status: string;
  declare rowCount: number | null;
  declare errorMessage: string | null;
  declare startedAt: Date;
  declare finishedAt: Date | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initImportHistory(sequelize: Sequelize): typeof ImportHistory {
  ImportHistory.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
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
    } as ModelAttributes<ImportHistory>,
    {
      sequelize,
      modelName: 'ImportHistory',
      tableName: 'import_histories',
      underscored: true,
      timestamps: true,
    }
  );
  return ImportHistory;
}
