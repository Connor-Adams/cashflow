const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Rule = sequelize.define(
    'Rule',
    {
      merchantPattern: {
        type: DataTypes.STRING(512),
        field: 'merchant_pattern',
        allowNull: false,
      },
      matchKind: {
        type: DataTypes.STRING(16),
        field: 'match_kind',
        allowNull: false,
        defaultValue: 'substring',
      },
      priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      category: { type: DataTypes.STRING(128), allowNull: true },
      isBusiness: {
        type: DataTypes.BOOLEAN,
        field: 'is_business',
        allowNull: false,
        defaultValue: false,
      },
      splitType: {
        type: DataTypes.STRING(16),
        field: 'split_type',
        allowNull: false,
        defaultValue: 'me',
      },
      pctMe: { type: DataTypes.DECIMAL(5, 4), field: 'pct_me', allowNull: true },
      pctPartner: {
        type: DataTypes.DECIMAL(5, 4),
        field: 'pct_partner',
        allowNull: true,
      },
    },
    {
      tableName: 'rules',
      underscored: true,
      timestamps: true,
    }
  );
  return Rule;
};
