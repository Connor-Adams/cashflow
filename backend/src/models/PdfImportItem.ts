import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
import type { PdfImportStatus } from './PdfImportBatch';

export class PdfImportItem extends Model<
  InferAttributes<PdfImportItem>, InferCreationAttributes<PdfImportItem>
> {
  declare id: string;
  declare batchId: string;
  declare fileName: string;
  declare storedFilename: string;
  declare storageKind: string;
  declare encryptionAlgorithm: string;
  declare status: PdfImportStatus;
  declare accountId: CreationOptional<number | null>;
  declare resultJson: CreationOptional<unknown | null>;
  declare error: CreationOptional<string | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initPdfImportItem(sequelize: Sequelize): typeof PdfImportItem {
  PdfImportItem.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      batchId: { type: DataTypes.UUID, field: 'batch_id', allowNull: false },
      fileName: { type: DataTypes.STRING(512), field: 'file_name', allowNull: false },
      storedFilename: { type: DataTypes.STRING(255), field: 'stored_filename', allowNull: false },
      storageKind: { type: DataTypes.STRING(16), field: 'storage_kind', allowNull: false },
      encryptionAlgorithm: { type: DataTypes.STRING(32), field: 'encryption_algorithm', allowNull: false, defaultValue: 'none' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending' },
      accountId: { type: DataTypes.INTEGER, field: 'account_id', allowNull: true },
      resultJson: { type: DataTypes.JSON, field: 'result_json', allowNull: true },
      error: { type: DataTypes.TEXT, allowNull: true },
    } as ModelAttributes<PdfImportItem>,
    { sequelize, modelName: 'PdfImportItem', tableName: 'pdf_import_items', underscored: true, timestamps: true },
  );
  return PdfImportItem;
}
