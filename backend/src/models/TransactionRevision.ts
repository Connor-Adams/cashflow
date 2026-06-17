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
 * Source tag for a transaction revision. Stored as STRING(32) so the value
 * set can grow without a destructive migration.
 *
 * - `user_edit`: explicit PATCH from the transactions UI.
 * - `bulk_patch`: a bulk-patch / bulk-patch-filter operation.
 * - `ai_suggestion`: AI suggestion accepted (link via aiSuggestionId).
 * - `import`: row created/updated by the import pipeline.
 * - `enrichment`: backfill / re-enrich pipeline mutated the row.
 * - `refund_link`: refund-link or refund-unlink flow touched the row.
 * - `system`: anything else (e.g. one-off scripts / hooks).
 *
 * `restore` is reserved for revisions created when a prior value is
 * re-applied via the restore endpoint — so the timeline can render
 * "restored to <value>" rather than a generic edit.
 */
export type TransactionRevisionSource =
  | 'user_edit'
  | 'bulk_patch'
  | 'ai_suggestion'
  | 'import'
  | 'enrichment'
  | 'refund_link'
  | 'restore'
  | 'system';

export type TransactionFieldChange = {
  field: string;
  before: unknown;
  after: unknown;
};

export class TransactionRevision extends Model<
  InferAttributes<TransactionRevision>,
  InferCreationAttributes<TransactionRevision>
> {
  declare id: CreationOptional<number>;
  declare transactionId: number;
  declare householdId: number | null;
  declare changedByUserId: number | null;
  declare source: CreationOptional<TransactionRevisionSource>;
  declare aiSuggestionId: number | null;
  /**
   * JSON-encoded array of {@link TransactionFieldChange}. Stored as TEXT
   * (rather than JSON/JSONB) so the same shape works against the in-memory
   * SQLite test harness used by the migration round-trip suite.
   */
  declare changes: string;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initTransactionRevision(
  sequelize: Sequelize,
): typeof TransactionRevision {
  TransactionRevision.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      transactionId: {
        type: DataTypes.INTEGER,
        field: 'transaction_id',
        allowNull: false,
      },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: true,
      },
      changedByUserId: {
        type: DataTypes.INTEGER,
        field: 'changed_by_user_id',
        allowNull: true,
      },
      source: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'user_edit',
      },
      aiSuggestionId: {
        type: DataTypes.INTEGER,
        field: 'ai_suggestion_id',
        allowNull: true,
      },
      changes: { type: DataTypes.TEXT, allowNull: false },
    } as ModelAttributes<TransactionRevision>,
    {
      sequelize,
      modelName: 'TransactionRevision',
      tableName: 'transaction_revisions',
      underscored: true,
      timestamps: true,
    },
  );
  return TransactionRevision;
}
