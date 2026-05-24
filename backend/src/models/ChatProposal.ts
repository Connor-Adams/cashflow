import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export type ChatProposalKind =
  | 'transaction_edit'
  | 'bulk_patch'
  | 'rule_create'
  | 'rule_update'
  | 'rule_delete';

export type ChatProposalStatus = 'pending' | 'applied' | 'rejected' | 'expired';

export class ChatProposal extends Model<
  InferAttributes<ChatProposal>,
  InferCreationAttributes<ChatProposal>
> {
  declare id: CreationOptional<number>;
  declare threadId: number;
  declare messageId: number;
  declare kind: ChatProposalKind;
  declare payload: Record<string, unknown>;
  declare preview: Record<string, unknown>;
  declare status: CreationOptional<ChatProposalStatus>;
  declare expiresAt: Date;
  declare appliedAt: Date | null;
  declare appliedResult: Record<string, unknown> | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initChatProposal(sequelize: Sequelize): typeof ChatProposal {
  ChatProposal.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      threadId: {
        type: DataTypes.INTEGER,
        field: 'thread_id',
        allowNull: false,
      },
      messageId: {
        type: DataTypes.INTEGER,
        field: 'message_id',
        allowNull: false,
      },
      kind: { type: DataTypes.STRING(32), allowNull: false },
      payload: { type: DataTypes.JSON, allowNull: false },
      preview: { type: DataTypes.JSON, allowNull: false },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'pending',
      },
      expiresAt: {
        type: DataTypes.DATE,
        field: 'expires_at',
        allowNull: false,
      },
      appliedAt: {
        type: DataTypes.DATE,
        field: 'applied_at',
        allowNull: true,
      },
      appliedResult: {
        type: DataTypes.JSON,
        field: 'applied_result',
        allowNull: true,
      },
    } as ModelAttributes<ChatProposal>,
    {
      sequelize,
      modelName: 'ChatProposal',
      tableName: 'chat_proposals',
      underscored: true,
      timestamps: true,
    }
  );
  return ChatProposal;
}
