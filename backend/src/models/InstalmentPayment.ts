import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class InstalmentPayment extends Model<
  InferAttributes<InstalmentPayment>,
  InferCreationAttributes<InstalmentPayment>
> {
  declare id: CreationOptional<number>;
  declare entityId: number;
  declare year: number;
  declare quarter: number | null;
  declare amount: string;
  declare paidOn: string;
  declare notes: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initInstalmentPayment(sequelize: Sequelize): typeof InstalmentPayment {
  InstalmentPayment.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      entityId: {
        type: DataTypes.INTEGER,
        field: 'entity_id',
        allowNull: false,
      },
      year: { type: DataTypes.INTEGER, allowNull: false },
      quarter: { type: DataTypes.INTEGER, allowNull: true },
      amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
      paidOn: {
        type: DataTypes.STRING(10),
        field: 'paid_on',
        allowNull: false,
      },
      notes: { type: DataTypes.TEXT, allowNull: true },
    } as ModelAttributes<InstalmentPayment>,
    {
      sequelize,
      modelName: 'InstalmentPayment',
      tableName: 'instalment_payments',
      underscored: true,
      timestamps: true,
      indexes: [
        {
          name: 'instalment_payments_entity_year',
          fields: ['entity_id', 'year'],
        },
      ],
    }
  );
  return InstalmentPayment;
}
