import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export type AiSuggestionKind =
  | 'transaction_fields'
  | 'transaction_audit'
  | 'amazon_item_categories'
  | 'receipt_extract'
  | 'financial_insight'
  | 'rule_proposal';

export type AiSuggestionStatus =
  | 'suggested'
  | 'accepted'
  | 'edited'
  | 'rejected'
  | 'superseded'
  | 'failed';

export class AiSuggestion extends Model<
  InferAttributes<AiSuggestion>,
  InferCreationAttributes<AiSuggestion>
> {
  declare id: CreationOptional<number>;
  declare householdId: number | null;
  declare userId: number | null;
  declare transactionId: number | null;
  declare receiptId: number | null;
  declare kind: AiSuggestionKind;
  declare status: CreationOptional<AiSuggestionStatus>;
  declare inputSnapshot: unknown;
  declare output: unknown;
  declare finalSnapshot: unknown;
  declare model: string | null;
  declare promptVersion: string | null;
  declare temperature: string | null;
  declare latencyMs: number | null;
  declare providerRequestId: string | null;
  declare errorMessage: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initAiSuggestion(sequelize: Sequelize): typeof AiSuggestion {
  AiSuggestion.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: true,
      },
      userId: {
        type: DataTypes.INTEGER,
        field: 'user_id',
        allowNull: true,
      },
      transactionId: {
        type: DataTypes.INTEGER,
        field: 'transaction_id',
        allowNull: true,
      },
      receiptId: {
        type: DataTypes.INTEGER,
        field: 'receipt_id',
        allowNull: true,
      },
      kind: { type: DataTypes.STRING(32), allowNull: false },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'suggested',
      },
      inputSnapshot: {
        type: DataTypes.JSON,
        field: 'input_snapshot',
        allowNull: true,
      },
      output: { type: DataTypes.JSON, allowNull: true },
      finalSnapshot: {
        type: DataTypes.JSON,
        field: 'final_snapshot',
        allowNull: true,
      },
      model: { type: DataTypes.STRING(128), allowNull: true },
      promptVersion: {
        type: DataTypes.STRING(64),
        field: 'prompt_version',
        allowNull: true,
      },
      temperature: { type: DataTypes.DECIMAL(4, 2), allowNull: true },
      latencyMs: {
        type: DataTypes.INTEGER,
        field: 'latency_ms',
        allowNull: true,
      },
      providerRequestId: {
        type: DataTypes.STRING(128),
        field: 'provider_request_id',
        allowNull: true,
      },
      errorMessage: {
        type: DataTypes.TEXT,
        field: 'error_message',
        allowNull: true,
      },
    } as ModelAttributes<AiSuggestion>,
    {
      sequelize,
      modelName: 'AiSuggestion',
      tableName: 'ai_suggestions',
      underscored: true,
      timestamps: true,
    }
  );
  return AiSuggestion;
}
