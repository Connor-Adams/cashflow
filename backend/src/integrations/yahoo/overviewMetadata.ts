import type { OverviewResult } from './client';
import type { SecurityMetadata } from '../../models/Security';

/**
 * Project a Yahoo overview payload onto the persisted Security.metadata shape.
 * Keeps the raw quoteSummary blob alongside the structured fields so we can
 * forensically recover any value later without re-querying Yahoo.
 */
export function overviewToMetadata(overview: OverviewResult): SecurityMetadata {
  return {
    sector: overview.sector,
    industry: overview.industry,
    country: overview.country,
    exchange: overview.exchange,
    description: overview.description,
    regularMarketPrice: overview.regularMarketPrice,
    previousClose: overview.previousClose,
    marketCap: overview.marketCap,
    trailingPE: overview.trailingPE,
    forwardPE: overview.forwardPE,
    trailingEps: overview.trailingEps,
    forwardEps: overview.forwardEps,
    beta: overview.beta,
    dayLow: overview.dayLow,
    dayHigh: overview.dayHigh,
    fiftyTwoWeekLow: overview.fiftyTwoWeekLow,
    fiftyTwoWeekHigh: overview.fiftyTwoWeekHigh,
    fiftyDayAverage: overview.fiftyDayAverage,
    twoHundredDayAverage: overview.twoHundredDayAverage,
    volume: overview.volume,
    averageVolume: overview.averageVolume,
    averageVolume10days: overview.averageVolume10days,
    sharesOutstanding: overview.sharesOutstanding,
    priceToBook: overview.priceToBook,
    bookValue: overview.bookValue,
    dividendRate: overview.dividendRate,
    dividendYield: overview.dividendYield,
    fiveYearAvgDividendYield: overview.fiveYearAvgDividendYield,
    payoutRatio: overview.payoutRatio,
    exDividendDate: overview.exDividendDate,
    totalRevenue: overview.totalRevenue,
    revenuePerShare: overview.revenuePerShare,
    grossMargins: overview.grossMargins,
    operatingMargins: overview.operatingMargins,
    profitMargins: overview.profitMargins,
    ebitdaMargins: overview.ebitdaMargins,
    returnOnAssets: overview.returnOnAssets,
    returnOnEquity: overview.returnOnEquity,
    totalCash: overview.totalCash,
    totalDebt: overview.totalDebt,
    debtToEquity: overview.debtToEquity,
    freeCashflow: overview.freeCashflow,
    operatingCashflow: overview.operatingCashflow,
    targetMeanPrice: overview.targetMeanPrice,
    targetHighPrice: overview.targetHighPrice,
    targetLowPrice: overview.targetLowPrice,
    recommendationMean: overview.recommendationMean,
    recommendationKey: overview.recommendationKey,
    numberOfAnalystOpinions: overview.numberOfAnalystOpinions,
    financialCurrency: overview.financialCurrency,
    raw: overview.raw,
  };
}
