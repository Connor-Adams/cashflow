import type { Sequelize } from 'sequelize';
import { DataTypes } from 'sequelize';

export default function defineAccount(sequelize: Sequelize) {
  return sequelize.define(
    'Account',
    {
      name: { type: DataTypes.STRING, allowNull: false },
      owner: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'me',
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
    },
    {
      tableName: 'accounts',
      underscored: true,
      timestamps: true,
    }
  );
}
