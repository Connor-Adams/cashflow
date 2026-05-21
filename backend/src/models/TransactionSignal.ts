import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class TransactionSignal extends Model<
  InferAttributes<TransactionSignal>,
  InferCreationAttributes<TransactionSignal>
> {
  declare id: CreationOptional<number>;
  declare transactionId: number;
  declare source: string;
  declare confidence: string;
  declare fields: Record<string, unknown>;
  declare rationale: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initTransactionSignal(
  sequelize: Sequelize,
): typeof TransactionSignal {
  TransactionSignal.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      transactionId: {
        type: DataTypes.INTEGER,
        field: 'transaction_id',
        allowNull: false,
      },
      source: { type: DataTypes.STRING(32), allowNull: false },
      confidence: { type: DataTypes.STRING(8), allowNull: false },
      fields: { type: DataTypes.JSON, allowNull: false },
      rationale: { type: DataTypes.TEXT, allowNull: true },
    } as ModelAttributes<TransactionSignal>,
    {
      sequelize,
      modelName: 'TransactionSignal',
      tableName: 'transaction_signals',
      underscored: true,
      timestamps: true,
    },
  );
  return TransactionSignal;
}
