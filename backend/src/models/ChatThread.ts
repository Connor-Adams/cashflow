import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class ChatThread extends Model<
  InferAttributes<ChatThread>,
  InferCreationAttributes<ChatThread>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare title: string | null;
  declare archivedAt: Date | null;
  declare lastMessageAt: Date | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initChatThread(sequelize: Sequelize): typeof ChatThread {
  ChatThread.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      userId: {
        type: DataTypes.INTEGER,
        field: 'user_id',
        allowNull: false,
      },
      title: { type: DataTypes.STRING(256), allowNull: true },
      archivedAt: {
        type: DataTypes.DATE,
        field: 'archived_at',
        allowNull: true,
      },
      lastMessageAt: {
        type: DataTypes.DATE,
        field: 'last_message_at',
        allowNull: true,
      },
    } as ModelAttributes<ChatThread>,
    {
      sequelize,
      modelName: 'ChatThread',
      tableName: 'chat_threads',
      underscored: true,
      timestamps: true,
    }
  );
  return ChatThread;
}
