import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class Account extends Model<
  InferAttributes<Account>,
  InferCreationAttributes<Account>
> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare owner: string;
  declare householdId: number | null;
  declare ownerUserId: number | null;
  declare visibility: CreationOptional<string>;
  declare accountType: CreationOptional<string>;
  declare shortCode: string | null;
  declare defaultCurrency: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initAccount(sequelize: Sequelize): typeof Account {
  Account.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      name: { type: DataTypes.STRING, allowNull: false },
      owner: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'me',
      },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: true,
      },
      ownerUserId: {
        type: DataTypes.INTEGER,
        field: 'owner_user_id',
        allowNull: true,
      },
      visibility: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'private',
      },
      accountType: {
        type: DataTypes.STRING(32),
        field: 'account_type',
        allowNull: false,
        defaultValue: 'checking',
      },
      shortCode: {
        type: DataTypes.STRING(64),
        field: 'short_code',
        allowNull: true,
      },
      defaultCurrency: {
        type: DataTypes.STRING(3),
        field: 'default_currency',
        allowNull: true,
      },
    } as ModelAttributes<Account>,
    {
      sequelize,
      modelName: 'Account',
      tableName: 'accounts',
      underscored: true,
      timestamps: true,
    }
  );
  return Account;
}
