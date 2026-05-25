/**
 * @deprecated Moved to `src/integrations/alphaVantage/client`. This module
 * is kept as a transitional re-export only; all call sites should import
 * from the canonical location.
 */
export {
  fetchGlobalQuote,
  fetchDailyAdjusted,
  fetchDividends,
  fetchOverview,
  AlphaVantageError,
} from '../integrations/alphaVantage/client';
export type {
  QuoteResult,
  DailyBar as AvDailyBar,
  DividendEvent as AvDividendEvent,
  OverviewResult as AvOverview,
} from '../integrations/alphaVantage/client';
