import { defineJob } from '../registry';
import { runBudgetBreachCheck } from '../../budgets/budgetBreachCheck';
import * as env from '../../config/env';

defineJob({
  name: 'budget_breach_check',
  cronDefault: env.budgetBreachCheckCron,
  enabledDefault: env.budgetBreachCheckEnabled,
  handler: async () => {
    const summary = await runBudgetBreachCheck();
    return { summary };
  },
});
