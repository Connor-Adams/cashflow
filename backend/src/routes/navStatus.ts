import { Router } from 'express';
import {
  BudgetTarget,
  FinancialGoal,
  FinancialScenario,
  IncomeEntry,
  PlannedEvent,
  VaultDocument,
} from '../models';
import { currentAuth } from '../auth/middleware';

const router = Router();

router.get('/', async (req, res) => {
  const { household } = currentAuth(req);
  const hid = household.id;
  const where = { householdId: hid };

  const [income, planned, goals, scenarios, vault, budgets] = await Promise.all([
    IncomeEntry.count({ where }),
    PlannedEvent.count({ where }),
    FinancialGoal.count({ where }),
    FinancialScenario.count({ where }),
    VaultDocument.count({ where }),
    BudgetTarget.count({ where }),
  ]);

  res.json({
    income: income > 0,
    planned: planned > 0,
    goals: goals > 0,
    scenarios: scenarios > 0,
    vault: vault > 0,
    budgets: budgets > 0,
  });
});

export default router;
