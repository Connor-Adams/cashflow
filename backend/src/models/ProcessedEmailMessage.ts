import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class ProcessedEmailMessage extends Model<
  InferAttributes<ProcessedEmailMessage>,
  InferCreationAttributes<ProcessedEmailMessage>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare provider: string;
  declare messageId: string;
  /** 'extracted' | 'filtered_subject' | 'no_items' | 'extraction_failed' | 'duplicate' */
  declare status: string;
  /** 'apple' | 'google' | 'amazon' | 'ai' | null */
  declare parser: string | null;
  declare externalOrderId: number | null;
  declare errorMessage: string | null;
  declare subject: string | null;
  declare fromAddr: string | null;
  declare scannedAt: Date;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initProcessedEmailMessage(
  sequelize: Sequelize,
): typeof ProcessedEmailMessage {
  ProcessedEmailMessage.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      provider: { type: DataTypes.STRING(32), allowNull: false },
      messageId: {
        type: DataTypes.STRING(128),
        field: 'message_id',
        allowNull: false,
      },
      status: { type: DataTypes.STRING(32), allowNull: false },
      parser: { type: DataTypes.STRING(32), allowNull: true },
      externalOrderId: {
        type: DataTypes.INTEGER,
        field: 'external_order_id',
        allowNull: true,
      },
      errorMessage: {
        type: DataTypes.TEXT,
        field: 'error_message',
        allowNull: true,
      },
      subject: { type: DataTypes.STRING(512), allowNull: true },
      fromAddr: {
        type: DataTypes.STRING(256),
        field: 'from_addr',
        allowNull: true,
      },
      scannedAt: {
        type: DataTypes.DATE,
        field: 'scanned_at',
        allowNull: false,
      },
    } as ModelAttributes<ProcessedEmailMessage>,
    {
      sequelize,
      modelName: 'ProcessedEmailMessage',
      tableName: 'processed_email_messages',
      underscored: true,
      timestamps: true,
    },
  );
  return ProcessedEmailMessage;
}
