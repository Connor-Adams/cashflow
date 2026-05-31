import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

/**
 * Join row linking a transaction to a label (issue #270). The composite
 * primary key (transaction_id, label_id) makes applying a label idempotent —
 * re-applying is an insert conflict, never a duplicate row (AC #6). FKs cascade
 * so deleting a transaction or a label removes its join rows (AC #9).
 *
 * Only a `created_at` timestamp is tracked (no updated_at): a join row is never
 * mutated, only created or deleted.
 */
export class TransactionLabel extends Model<
  InferAttributes<TransactionLabel>,
  InferCreationAttributes<TransactionLabel>
> {
  declare transactionId: number;
  declare labelId: number;
  declare readonly createdAt: CreationOptional<Date>;
}

export function initTransactionLabel(sequelize: Sequelize): typeof TransactionLabel {
  TransactionLabel.init(
    {
      transactionId: {
        type: DataTypes.INTEGER,
        field: 'transaction_id',
        allowNull: false,
        primaryKey: true,
      },
      labelId: {
        type: DataTypes.INTEGER,
        field: 'label_id',
        allowNull: false,
        primaryKey: true,
      },
      createdAt: {
        type: DataTypes.DATE,
        field: 'created_at',
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    } as ModelAttributes<TransactionLabel>,
    {
      sequelize,
      modelName: 'TransactionLabel',
      tableName: 'transaction_labels',
      underscored: true,
      timestamps: false,
      indexes: [{ fields: ['label_id', 'transaction_id'] }],
    }
  );
  return TransactionLabel;
}
