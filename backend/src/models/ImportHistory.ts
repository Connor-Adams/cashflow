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
  declare householdId: number | null;
  declare createdByUserId: number | null;
  declare filePathSafe: string;
  declare contentHash: string;
  declare batchLabel: string;
  declare status: string;
  declare rowCount: number | null;
  declare errorMessage: string | null;
  declare startedAt: Date;
  declare finishedAt: Date | null;
  /** Account this batch targeted (#231). NULL for legacy rows or batches
   *  that did not resolve an account (e.g. bad-filename failures). */
  declare accountId: CreationOptional<number | null>;
  /** CSV profile used (`generic_simple`, `auto`, etc., #231). NULL for
   *  non-CSV imports or legacy rows. */
  declare profileId: CreationOptional<string | null>;
  /** How many transactions were actually inserted in this run (#231).
   *  Mirrors the per-run `inserted` value. NULL for legacy rows. */
  declare insertedCount: CreationOptional<number | null>;
  /** Rows skipped because they matched an existing transaction (#231). */
  declare skippedDuplicateCount: CreationOptional<number | null>;
  /** Rows that failed parsing/mapping during import (#231). */
  declare rowErrorsCount: CreationOptional<number | null>;
  /** When this batch was rolled back (#233). NULL on healthy batches. */
  declare rolledBackAt: CreationOptional<Date | null>;
  /** Actor who executed the rollback (#233). NULL on healthy batches. */
  declare rolledBackByUserId: CreationOptional<number | null>;
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
      accountId: {
        type: DataTypes.INTEGER,
        field: 'account_id',
        allowNull: true,
      },
      profileId: {
        type: DataTypes.STRING(64),
        field: 'profile_id',
        allowNull: true,
      },
      insertedCount: {
        type: DataTypes.INTEGER,
        field: 'inserted_count',
        allowNull: true,
      },
      skippedDuplicateCount: {
        type: DataTypes.INTEGER,
        field: 'skipped_duplicate_count',
        allowNull: true,
      },
      rowErrorsCount: {
        type: DataTypes.INTEGER,
        field: 'row_errors_count',
        allowNull: true,
      },
      rolledBackAt: {
        type: DataTypes.DATE,
        field: 'rolled_back_at',
        allowNull: true,
      },
      rolledBackByUserId: {
        type: DataTypes.INTEGER,
        field: 'rolled_back_by_user_id',
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
