import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class Receipt extends Model<
  InferAttributes<Receipt>,
  InferCreationAttributes<Receipt>
> {
  declare id: CreationOptional<number>;
  declare transactionId: number;
  declare storedFilename: string;
  declare originalName: string;
  declare mimeType: string;
  declare sizeBytes: number;
  declare extractedNote: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initReceipt(sequelize: Sequelize): typeof Receipt {
  Receipt.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      transactionId: {
        type: DataTypes.INTEGER,
        field: 'transaction_id',
        allowNull: false,
      },
      storedFilename: {
        type: DataTypes.STRING(256),
        field: 'stored_filename',
        allowNull: false,
      },
      originalName: {
        type: DataTypes.STRING(512),
        field: 'original_name',
        allowNull: false,
      },
      mimeType: {
        type: DataTypes.STRING(128),
        field: 'mime_type',
        allowNull: false,
      },
      sizeBytes: {
        type: DataTypes.INTEGER,
        field: 'size_bytes',
        allowNull: false,
      },
      extractedNote: {
        type: DataTypes.TEXT,
        field: 'extracted_note',
        allowNull: true,
      },
    } as ModelAttributes<Receipt>,
    {
      sequelize,
      modelName: 'Receipt',
      tableName: 'receipts',
      underscored: true,
      timestamps: true,
    }
  );
  return Receipt;
}
