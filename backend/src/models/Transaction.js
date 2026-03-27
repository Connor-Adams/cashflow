const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Transaction = sequelize.define(
    'Transaction',
    {
      accountId: {
        type: DataTypes.INTEGER,
        field: 'account_id',
        allowNull: false,
      },
      importBatch: {
        type: DataTypes.STRING(128),
        field: 'import_batch',
        allowNull: false,
      },
      date: { type: DataTypes.DATEONLY, allowNull: false },
      merchantRaw: {
        type: DataTypes.STRING(1024),
        field: 'merchant_raw',
        allowNull: false,
      },
      merchantClean: {
        type: DataTypes.STRING(1024),
        field: 'merchant_clean',
        allowNull: false,
      },
      amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      notes: { type: DataTypes.TEXT, allowNull: true },
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
      appliedRuleId: {
        type: DataTypes.INTEGER,
        field: 'applied_rule_id',
        allowNull: true,
      },

      autoCategory: {
        type: DataTypes.STRING(128),
        field: 'auto_category',
        allowNull: true,
      },
      categoryOverride: {
        type: DataTypes.STRING(128),
        field: 'category_override',
        allowNull: true,
      },
      finalCategory: {
        type: DataTypes.STRING(128),
        field: 'final_category',
        allowNull: true,
      },

      autoBusiness: {
        type: DataTypes.BOOLEAN,
        field: 'auto_business',
        allowNull: true,
      },
      businessOverride: {
        type: DataTypes.BOOLEAN,
        field: 'business_override',
        allowNull: true,
      },
      finalBusiness: {
        type: DataTypes.BOOLEAN,
        field: 'final_business',
        allowNull: false,
        defaultValue: false,
      },

      autoSplitType: {
        type: DataTypes.STRING(16),
        field: 'auto_split_type',
        allowNull: true,
      },
      splitOverride: {
        type: DataTypes.STRING(16),
        field: 'split_override',
        allowNull: true,
      },
      finalSplitType: {
        type: DataTypes.STRING(16),
        field: 'final_split_type',
        allowNull: false,
        defaultValue: 'me',
      },

      autoPctMe: {
        type: DataTypes.DECIMAL(5, 4),
        field: 'auto_pct_me',
        allowNull: true,
      },
      pctMeOverride: {
        type: DataTypes.DECIMAL(5, 4),
        field: 'pct_me_override',
        allowNull: true,
      },
      finalPctMe: {
        type: DataTypes.DECIMAL(5, 4),
        field: 'final_pct_me',
        allowNull: true,
      },

      autoPctPartner: {
        type: DataTypes.DECIMAL(5, 4),
        field: 'auto_pct_partner',
        allowNull: true,
      },
      pctPartnerOverride: {
        type: DataTypes.DECIMAL(5, 4),
        field: 'pct_partner_override',
        allowNull: true,
      },
      finalPctPartner: {
        type: DataTypes.DECIMAL(5, 4),
        field: 'final_pct_partner',
        allowNull: true,
      },

      myShareAmount: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'my_share_amount',
        allowNull: false,
        defaultValue: 0,
      },
      partnerShareAmount: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'partner_share_amount',
        allowNull: false,
        defaultValue: 0,
      },
      businessAmount: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'business_amount',
        allowNull: false,
        defaultValue: 0,
      },

      reviewFlag: {
        type: DataTypes.BOOLEAN,
        field: 'review_flag',
        allowNull: false,
        defaultValue: false,
      },
      reviewedAt: {
        type: DataTypes.DATE,
        field: 'reviewed_at',
        allowNull: true,
      },
    },
    {
      tableName: 'transactions',
      underscored: true,
      timestamps: true,
    }
  );
  return Transaction;
};
