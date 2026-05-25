/**
 * @deprecated The in-memory `RateBudget` was removed in favor of the
 * DB-backed accounting in `src/integrations/alphaVantage/budget`. Coverage
 * for the shared budget now lives in
 * `test/integrations/alphaVantage/budget.test.ts`. This file is kept as an
 * intentionally-empty placeholder so the test runner's glob still resolves.
 */
import { test } from 'node:test';

test('rateBudget module removed — coverage moved to integrations/alphaVantage/budget.test.ts', () => {
  // Sentinel test to keep the test runner happy.
});
