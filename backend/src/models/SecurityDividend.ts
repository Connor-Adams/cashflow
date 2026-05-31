import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class SecurityDividend extends Model<
  InferAttributes<SecurityDividend>,
  InferCreationAttributes<SecurityDividend>
> {
  declare id: CreationOptional<number>;
  declare securityId: number;
  declare exDividendDate: string;
  declare declarationDate: string | null;
  declare recordDate: string | null;
  declare paymentDate: string | null;
  declare amount: string;
  declare currency: string;
  declare source: CreationOptional<string>;
  declare fetchedAt: Date;
  declare matchedTransactionId: number | null;
  declare matchedAt: Date | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initSecurityDividend(sequelize: Sequelize): typeof SecurityDividend {
  SecurityDividend.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      securityId: {
        type: DataTypes.INTEGER,
        field: 'security_id',
        allowNull: false,
      },
      exDividendDate: {
        type: DataTypes.DATEONLY,
        field: 'ex_dividend_date',
        allowNull: false,
      },
      declarationDate: {
        type: DataTypes.DATEONLY,
        field: 'declaration_date',
        allowNull: true,
      },
      recordDate: {
        type: DataTypes.DATEONLY,
        field: 'record_date',
        allowNull: true,
      },
      paymentDate: {
        type: DataTypes.DATEONLY,
        field: 'payment_date',
        allowNull: true,
      },
      amount: { type: DataTypes.DECIMAL(20, 8), allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      source: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'yahoo',
      },
      fetchedAt: {
        type: DataTypes.DATE,
        field: 'fetched_at',
        allowNull: false,
      },
      matchedTransactionId: {
        type: DataTypes.BIGINT,
        field: 'matched_transaction_id',
        allowNull: true,
      },
      matchedAt: {
        type: DataTypes.DATE,
        field: 'matched_at',
        allowNull: true,
      },
    } as ModelAttributes<SecurityDividend>,
    {
      sequelize,
      modelName: 'SecurityDividend',
      tableName: 'security_dividends',
      underscored: true,
      timestamps: true,
    },
  );
  return SecurityDividend;
}
