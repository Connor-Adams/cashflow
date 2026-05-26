import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export interface NextExDivEntry {
  date: string;             // ISO date 'YYYY-MM-DD'
  estimatedPerShare: number;
  kind: 'dividend' | 'interest';
}

export class PortfolioForwardProjection extends Model<
  InferAttributes<PortfolioForwardProjection>,
  InferCreationAttributes<PortfolioForwardProjection>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare securityId: number;
  declare qtyBasis: string;
  declare annualDividendPerShare: string;
  declare annualInterestPerShare: string;
  declare projectedAnnualIncomeNative: string;
  declare currency: string;
  declare cadenceLabel: 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'irregular' | 'none';
  declare medianSpacingDays: number | null;
  declare cvPct: string | null;
  declare unreliable: boolean;
  declare nextExDivDates: NextExDivEntry[];
  declare computedAt: Date;
  declare staleAt: Date | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initPortfolioForwardProjection(
  sequelize: Sequelize,
): typeof PortfolioForwardProjection {
  PortfolioForwardProjection.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: { type: DataTypes.INTEGER, field: 'household_id', allowNull: false },
      securityId: { type: DataTypes.INTEGER, field: 'security_id', allowNull: false },
      qtyBasis: { type: DataTypes.DECIMAL(20, 8), field: 'qty_basis', allowNull: false },
      annualDividendPerShare: {
        type: DataTypes.DECIMAL(20, 8),
        field: 'annual_dividend_per_share',
        allowNull: false,
        defaultValue: '0',
      },
      annualInterestPerShare: {
        type: DataTypes.DECIMAL(20, 8),
        field: 'annual_interest_per_share',
        allowNull: false,
        defaultValue: '0',
      },
      projectedAnnualIncomeNative: {
        type: DataTypes.DECIMAL(20, 2),
        field: 'projected_annual_income_native',
        allowNull: false,
        defaultValue: '0',
      },
      currency: { type: DataTypes.STRING(8), allowNull: false },
      cadenceLabel: { type: DataTypes.STRING(16), field: 'cadence_label', allowNull: false },
      medianSpacingDays: { type: DataTypes.INTEGER, field: 'median_spacing_days', allowNull: true },
      cvPct: { type: DataTypes.DECIMAL(8, 4), field: 'cv_pct', allowNull: true },
      unreliable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      nextExDivDates: {
        type: DataTypes.JSON,
        field: 'next_ex_div_dates',
        allowNull: false,
        defaultValue: [],
      },
      computedAt: { type: DataTypes.DATE, field: 'computed_at', allowNull: false },
      staleAt: { type: DataTypes.DATE, field: 'stale_at', allowNull: true },
    } as ModelAttributes<PortfolioForwardProjection>,
    {
      sequelize,
      modelName: 'PortfolioForwardProjection',
      tableName: 'portfolio_forward_projections',
      underscored: true,
      timestamps: true,
    },
  );
  return PortfolioForwardProjection;
}
