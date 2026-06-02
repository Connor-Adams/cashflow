import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export type PdfImportStatus = 'pending' | 'processing' | 'done' | 'failed';

export class PdfImportBatch extends Model<
  InferAttributes<PdfImportBatch>, InferCreationAttributes<PdfImportBatch>
> {
  declare id: string;
  declare householdId: number;
  declare userId: number;
  declare status: PdfImportStatus;
  declare total: number;
  declare processed: number;
  declare succeeded: number;
  declare failed: number;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initPdfImportBatch(sequelize: Sequelize): typeof PdfImportBatch {
  PdfImportBatch.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      householdId: { type: DataTypes.INTEGER, field: 'household_id', allowNull: false },
      userId: { type: DataTypes.INTEGER, field: 'user_id', allowNull: false },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending' },
      total: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      processed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      succeeded: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      failed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    } as ModelAttributes<PdfImportBatch>,
    { sequelize, modelName: 'PdfImportBatch', tableName: 'pdf_import_batches', underscored: true, timestamps: true },
  );
  return PdfImportBatch;
}
