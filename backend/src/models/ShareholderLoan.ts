import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export type ShareholderLoanKind = 'advance' | 'repayment' | 'dividend_credit' | 'salary_credit';

export class ShareholderLoan extends Model<
  InferAttributes<ShareholderLoan>,
  InferCreationAttributes<ShareholderLoan>
> {
  declare id: CreationOptional<number>;
  declare entityId: number;
  declare date: string;
  declare kind: ShareholderLoanKind;
  declare amount: string;
  declare description: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initShareholderLoan(sequelize: Sequelize): typeof ShareholderLoan {
  ShareholderLoan.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      entityId: {
        type: DataTypes.INTEGER,
        field: 'entity_id',
        allowNull: false,
      },
      date: { type: DataTypes.DATEONLY, allowNull: false },
      kind: { type: DataTypes.STRING(24), allowNull: false },
      amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
    } as ModelAttributes<ShareholderLoan>,
    {
      sequelize,
      modelName: 'ShareholderLoan',
      tableName: 'shareholder_loans',
      underscored: true,
      timestamps: true,
      indexes: [
        {
          name: 'shareholder_loans_entity_date',
          fields: ['entity_id', 'date'],
        },
      ],
    }
  );
  return ShareholderLoan;
}
