import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export type SecurityDividendEligibility = 'eligible' | 'non_eligible' | 'unknown';

export type SecurityMetadata = {
  sector?: string | null;
  industry?: string | null;
  country?: string | null;
  exchange?: string | null;
  description?: string | null;
  // Market data
  regularMarketPrice?: number | null;
  previousClose?: number | null;
  marketCap?: number | null;
  trailingPE?: number | null;
  forwardPE?: number | null;
  trailingEps?: number | null;
  forwardEps?: number | null;
  beta?: number | null;
  dayLow?: number | null;
  dayHigh?: number | null;
  fiftyTwoWeekLow?: number | null;
  fiftyTwoWeekHigh?: number | null;
  fiftyDayAverage?: number | null;
  twoHundredDayAverage?: number | null;
  volume?: number | null;
  averageVolume?: number | null;
  averageVolume10days?: number | null;
  sharesOutstanding?: number | null;
  priceToBook?: number | null;
  bookValue?: number | null;
  // Dividend stats
  dividendRate?: number | null;
  dividendYield?: number | null;
  fiveYearAvgDividendYield?: number | null;
  payoutRatio?: number | null;
  exDividendDate?: string | null;
  // Fundamentals
  totalRevenue?: number | null;
  revenuePerShare?: number | null;
  grossMargins?: number | null;
  operatingMargins?: number | null;
  profitMargins?: number | null;
  ebitdaMargins?: number | null;
  returnOnAssets?: number | null;
  returnOnEquity?: number | null;
  totalCash?: number | null;
  totalDebt?: number | null;
  debtToEquity?: number | null;
  freeCashflow?: number | null;
  operatingCashflow?: number | null;
  // Analyst targets
  targetMeanPrice?: number | null;
  targetHighPrice?: number | null;
  targetLowPrice?: number | null;
  recommendationMean?: number | null;
  recommendationKey?: string | null;
  numberOfAnalystOpinions?: number | null;
  financialCurrency?: string | null;
  // Raw passthrough — full quoteSummary for forensics / future fields.
  [key: string]: unknown;
};

export class Security extends Model<
  InferAttributes<Security>,
  InferCreationAttributes<Security>
> {
  declare id: CreationOptional<number>;
  declare householdId: number | null;
  declare symbol: string;
  declare name: string | null;
  declare assetType: string | null;
  declare currency: string;
  declare dividendEligibility: CreationOptional<SecurityDividendEligibility>;
  declare metadata: SecurityMetadata | null;
  declare metadataFetchedAt: Date | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initSecurity(sequelize: Sequelize): typeof Security {
  Security.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: true,
      },
      symbol: { type: DataTypes.STRING(64), allowNull: false },
      name: { type: DataTypes.STRING(256), allowNull: true },
      assetType: {
        type: DataTypes.STRING(64),
        field: 'asset_type',
        allowNull: true,
      },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      dividendEligibility: {
        type: DataTypes.STRING(16),
        field: 'dividend_eligibility',
        allowNull: false,
        defaultValue: 'eligible',
      },
      metadata: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: null,
      },
      metadataFetchedAt: {
        type: DataTypes.DATE,
        field: 'metadata_fetched_at',
        allowNull: true,
      },
    } as ModelAttributes<Security>,
    {
      sequelize,
      modelName: 'Security',
      tableName: 'securities',
      underscored: true,
      timestamps: true,
    }
  );
  return Security;
}
