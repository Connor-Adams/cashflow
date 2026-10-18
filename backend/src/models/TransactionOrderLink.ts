import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class TransactionOrderLink extends Model<
  InferAttributes<TransactionOrderLink>,
  InferCreationAttributes<TransactionOrderLink>
> {
  declare id: CreationOptional<number>;
  declare transactionId: number;
  declare externalOrderId: number;
  declare confidence: string;
  declare matchReason: string;
  declare status: CreationOptional<string>;
  declare linkedAmount: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initTransactionOrderLink(sequelize: Sequelize): typeof TransactionOrderLink {
  TransactionOrderLink.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      transactionId: { type: DataTypes.INTEGER, field: 'transaction_id', allowNull: false },
      externalOrderId: {
        type: DataTypes.INTEGER,
        field: 'external_order_id',
        allowNull: false,
      },
      confidence: { type: DataTypes.DECIMAL(5, 2), allowNull: false },
      matchReason: { type: DataTypes.TEXT, field: 'match_reason', allowNull: false },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'suggested' },
      linkedAmount: { type: DataTypes.DECIMAL(14, 4), field: 'linked_amount', allowNull: true },
    } as ModelAttributes<TransactionOrderLink>,
    {
      sequelize,
      modelName: 'TransactionOrderLink',
      tableName: 'transaction_order_links',
      underscored: true,
      timestamps: true,
    }
  );
  return TransactionOrderLink;
}
