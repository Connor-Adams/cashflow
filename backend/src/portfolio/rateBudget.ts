/**
 * @deprecated Removed. The in-memory `RateBudget` has been replaced by the
 * DB-backed accounting in `src/integrations/alphaVantage/budget`, which is
 * shared with the background scheduler. New callers should use
 * `checkBudget` + `recordCall` from that module.
 */
export {};
