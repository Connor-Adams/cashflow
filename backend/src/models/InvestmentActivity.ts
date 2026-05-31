import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class InvestmentActivity extends Model<
  InferAttributes<InvestmentActivity>,
  InferCreationAttributes<InvestmentActivity>
> {
  declare id: CreationOptional<number>;
  declare accountId: number;
  declare householdId: number | null;
  declare securityId: number | null;
  declare activityType: string;
  declare tradeDate: string;
  declare settlementDate: string | null;
  declare description: string;
  declare quantity: string | null;
  declare price: string | null;
  declare amount: string | null;
  declare fees: string | null;
  declare splitRatio: string | null;
  declare currency: string;
  declare sourceReference: string | null;
  declare sourceRowFingerprint: string;
  declare importBatch: string;
  declare recipientSecurityId: CreationOptional<number | null>;
  declare costBasisAllocationPct: CreationOptional<string | null>;
  declare cashComponent: CreationOptional<string | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initInvestmentActivity(
  sequelize: Sequelize
): typeof InvestmentActivity {
  InvestmentActivity.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      accountId: {
        type: DataTypes.INTEGER,
        field: 'account_id',
        allowNull: false,
      },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: true,
      },
      securityId: {
        type: DataTypes.INTEGER,
        field: 'security_id',
        allowNull: true,
      },
      activityType: {
        type: DataTypes.STRING(32),
        field: 'activity_type',
        allowNull: false,
      },
      tradeDate: {
        type: DataTypes.DATEONLY,
        field: 'trade_date',
        allowNull: false,
      },
      settlementDate: {
        type: DataTypes.DATEONLY,
        field: 'settlement_date',
        allowNull: true,
      },
      description: { type: DataTypes.STRING(1024), allowNull: false },
      quantity: { type: DataTypes.DECIMAL(28, 10), allowNull: true },
      price: { type: DataTypes.DECIMAL(20, 8), allowNull: true },
      amount: { type: DataTypes.DECIMAL(14, 4), allowNull: true },
      fees: { type: DataTypes.DECIMAL(14, 4), allowNull: true },
      splitRatio: {
        type: DataTypes.DECIMAL(10, 6),
        field: 'split_ratio',
        allowNull: true,
      },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      sourceReference: {
        type: DataTypes.STRING(256),
        field: 'source_reference',
        allowNull: true,
      },
      sourceRowFingerprint: {
        type: DataTypes.STRING(128),
        field: 'source_row_fingerprint',
        allowNull: false,
      },
      importBatch: {
        type: DataTypes.STRING(128),
        field: 'import_batch',
        allowNull: false,
      },
      recipientSecurityId: {
        type: DataTypes.INTEGER,
        field: 'recipient_security_id',
        allowNull: true,
        defaultValue: null,
      },
      costBasisAllocationPct: {
        type: DataTypes.DECIMAL(5, 4),
        field: 'cost_basis_allocation_pct',
        allowNull: true,
        defaultValue: null,
      },
      cashComponent: {
        type: DataTypes.DECIMAL(18, 4),
        field: 'cash_component',
        allowNull: true,
        defaultValue: null,
      },
    } as ModelAttributes<InvestmentActivity>,
    {
      sequelize,
      modelName: 'InvestmentActivity',
      tableName: 'investment_activities',
      underscored: true,
      timestamps: true,
    }
  );
  return InvestmentActivity;
}
