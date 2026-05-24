import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export type ChatMessageRole = 'user' | 'assistant' | 'tool';

/** Shape of an entry in `tool_calls` JSON column on assistant messages. */
export interface StoredToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export class ChatMessage extends Model<
  InferAttributes<ChatMessage>,
  InferCreationAttributes<ChatMessage>
> {
  declare id: CreationOptional<number>;
  declare threadId: number;
  declare role: ChatMessageRole;
  declare contentText: string | null;
  declare toolCalls: StoredToolCall[] | null;
  declare toolCallId: string | null;
  declare toolName: string | null;
  declare model: string | null;
  declare promptTokens: number | null;
  declare completionTokens: number | null;
  declare latencyMs: number | null;
  declare providerRequestId: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initChatMessage(sequelize: Sequelize): typeof ChatMessage {
  ChatMessage.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      threadId: {
        type: DataTypes.INTEGER,
        field: 'thread_id',
        allowNull: false,
      },
      role: { type: DataTypes.STRING(16), allowNull: false },
      contentText: {
        type: DataTypes.TEXT,
        field: 'content_text',
        allowNull: true,
      },
      toolCalls: {
        type: DataTypes.JSON,
        field: 'tool_calls',
        allowNull: true,
      },
      toolCallId: {
        type: DataTypes.STRING(128),
        field: 'tool_call_id',
        allowNull: true,
      },
      toolName: {
        type: DataTypes.STRING(64),
        field: 'tool_name',
        allowNull: true,
      },
      model: { type: DataTypes.STRING(64), allowNull: true },
      promptTokens: {
        type: DataTypes.INTEGER,
        field: 'prompt_tokens',
        allowNull: true,
      },
      completionTokens: {
        type: DataTypes.INTEGER,
        field: 'completion_tokens',
        allowNull: true,
      },
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
    } as ModelAttributes<ChatMessage>,
    {
      sequelize,
      modelName: 'ChatMessage',
      tableName: 'chat_messages',
      underscored: true,
      timestamps: true,
    }
  );
  return ChatMessage;
}
