import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export type IncomeSource = 'paycheck' | 'invoice' | 'cash' | 'gift' | 'refund' | 'other';

export const INCOME_SOURCES: readonly IncomeSource[] = [
  'paycheck',
  'invoice',
  'cash',
  'gift',
  'refund',
  'other',
];

export class IncomeEntry extends Model<
  InferAttributes<IncomeEntry>,
  InferCreationAttributes<IncomeEntry>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare householdId: number;
  declare occurredOn: string;
  declare grossAmountCents: number;
  declare currency: string;
  declare taxWithheldCents: number | null;
  declare netAmountCents: number;
  declare categoryId: number | null;
  declare counterpartyContactId: number | null;
  declare source: IncomeSource;
  declare notes: string | null;
  declare accountId: number | null;
  declare linkedTransactionId: number | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initIncomeEntry(sequelize: Sequelize): typeof IncomeEntry {
  IncomeEntry.init(
    {
      id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
      userId: { type: DataTypes.INTEGER, field: 'user_id', allowNull: false },
      householdId: { type: DataTypes.INTEGER, field: 'household_id', allowNull: false },
      occurredOn: { type: DataTypes.DATEONLY, field: 'occurred_on', allowNull: false },
      grossAmountCents: { type: DataTypes.BIGINT, field: 'gross_amount_cents', allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      taxWithheldCents: { type: DataTypes.BIGINT, field: 'tax_withheld_cents', allowNull: true },
      netAmountCents: { type: DataTypes.BIGINT, field: 'net_amount_cents', allowNull: false },
      categoryId: { type: DataTypes.INTEGER, field: 'category_id', allowNull: true },
      counterpartyContactId: { type: DataTypes.INTEGER, field: 'counterparty_contact_id', allowNull: true },
      source: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'other',
      },
      notes: { type: DataTypes.TEXT, allowNull: true },
      accountId: { type: DataTypes.INTEGER, field: 'account_id', allowNull: true },
      linkedTransactionId: { type: DataTypes.INTEGER, field: 'linked_transaction_id', allowNull: true },
    } as ModelAttributes<IncomeEntry>,
    {
      sequelize,
      modelName: 'IncomeEntry',
      tableName: 'income_entries',
      underscored: true,
      timestamps: true,
    },
  );
  return IncomeEntry;
}
