import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export type AccountTaxStatus =
  | 'registered_rrsp'
  | 'registered_tfsa'
  | 'registered_fhsa'
  | 'registered_rrif'
  | 'non_registered'
  | 'n_a';

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
  declare entityId: number | null;
  declare taxStatus: CreationOptional<AccountTaxStatus>;
  declare openingBalance: CreationOptional<string>;
  declare openingBalanceDate: CreationOptional<string | null>;
  declare closedAt: CreationOptional<string | null>;
  declare notes: CreationOptional<string | null>;
  declare mergedIntoId: CreationOptional<number | null>;
  declare mergedAt: CreationOptional<Date | null>;
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
      entityId: {
        type: DataTypes.INTEGER,
        field: 'entity_id',
        allowNull: true,
      },
      taxStatus: {
        type: DataTypes.STRING(32),
        field: 'tax_status',
        allowNull: false,
        defaultValue: 'n_a',
      },
      openingBalance: {
        type: DataTypes.DECIMAL(18, 4),
        field: 'opening_balance',
        allowNull: false,
        defaultValue: 0,
      },
      openingBalanceDate: {
        type: DataTypes.DATEONLY,
        field: 'opening_balance_date',
        allowNull: true,
        defaultValue: null,
      },
      closedAt: {
        type: DataTypes.DATEONLY,
        field: 'closed_at',
        allowNull: true,
        defaultValue: null,
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
        defaultValue: null,
      },
      mergedIntoId: {
        type: DataTypes.BIGINT,
        field: 'merged_into_id',
        allowNull: true,
        defaultValue: null,
      },
      mergedAt: {
        type: DataTypes.DATE,
        field: 'merged_at',
        allowNull: true,
        defaultValue: null,
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
