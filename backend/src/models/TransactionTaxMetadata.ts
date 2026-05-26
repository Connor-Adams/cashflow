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
 * Per-transaction sidecar with tax-hygiene metadata. 1:1 with `transactions`
 * (transaction_id is PK). Stored separately because most rows don't carry
 * tax metadata; keeping it off the hot transactions table avoids bloating
 * the row-cache footprint.
 *
 * `deductiblePercent` is a fraction in [0, 1] (DECIMAL(5,4)) so the engine
 * can multiply with raw `amount`/`businessAmount` cleanly. `hstGstAmount`
 * is the (optional) sales-tax portion baked into the transaction's gross
 * amount; if null, the dashboard estimates with the configured rate or
 * skips it.
 */
export class TransactionTaxMetadata extends Model<
  InferAttributes<TransactionTaxMetadata>,
  InferCreationAttributes<TransactionTaxMetadata>
> {
  declare transactionId: number;
  declare taxTagId: number | null;
  declare deductiblePercent: CreationOptional<string>;
  declare hstGstAmount: string | null;
  declare receiptRequired: CreationOptional<boolean>;
  declare reviewedForTax: CreationOptional<boolean>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initTransactionTaxMetadata(
  sequelize: Sequelize,
): typeof TransactionTaxMetadata {
  TransactionTaxMetadata.init(
    {
      transactionId: {
        type: DataTypes.INTEGER,
        field: 'transaction_id',
        primaryKey: true,
        allowNull: false,
      },
      taxTagId: {
        type: DataTypes.INTEGER,
        field: 'tax_tag_id',
        allowNull: true,
      },
      deductiblePercent: {
        type: DataTypes.DECIMAL(5, 4),
        field: 'deductible_percent',
        allowNull: false,
        defaultValue: 1,
      },
      hstGstAmount: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'hst_gst_amount',
        allowNull: true,
      },
      receiptRequired: {
        type: DataTypes.BOOLEAN,
        field: 'receipt_required',
        allowNull: false,
        defaultValue: false,
      },
      reviewedForTax: {
        type: DataTypes.BOOLEAN,
        field: 'reviewed_for_tax',
        allowNull: false,
        defaultValue: false,
      },
    } as ModelAttributes<TransactionTaxMetadata>,
    {
      sequelize,
      modelName: 'TransactionTaxMetadata',
      tableName: 'transaction_tax_metadata',
      underscored: true,
      timestamps: true,
    },
  );
  return TransactionTaxMetadata;
}
