/**
 * Financial scenario planner API (issue #213).
 *
 * Lets a user model hypothetical financial changes ("what if income drops
 * 30%?", "what if I save $2,000/month?", "what if I buy a car?") WITHOUT
 * mutating real transactions or planned events, and compare the base forecast
 * against the scenario across projected balance, safe-to-spend, and net worth.
 *
 *   GET    /api/financial-scenarios       list (stored results, no recompute)
 *   POST   /api/financial-scenarios       create + compute + persist
 *   GET    /api/financial-scenarios/:id   recompute against current data
 *   DELETE /api/financial-scenarios/:id   delete
 *
 * Naming note: the tax domain already owns `scenarios`/`Scenario`, so this
 * feature lives under `financial_scenarios`/`FinancialScenario` and the route
 * is mounted at `/api/financial-scenarios`.
 */
import { Router, type Request } from 'express';
import { FinancialScenario } from '../models/FinancialScenario';
import {
  MIN_FINANCIAL_SCENARIO_HORIZON_DAYS,
  MAX_FINANCIAL_SCENARIO_HORIZON_DAYS,
  FINANCIAL_SCENARIO_DEFAULT_HORIZON_DAYS,
} from '../models/FinancialScenario';
import { Account } from '../models';
import { currentAuth } from '../auth/middleware';
import { householdWhere, visibleAccountWhere } from '../auth/scope';
import { balanceAtDate } from '../networth/balanceAtDate';
import { buildNetWorthAt } from '../networth/aggregate';
import { computeSafeToSpend } from '../cashflow/safeToSpend';
import { loadSettingsOrDefaults } from '../cashflow/safeToSpend';
import { gatherForecastInputs } from '../forecast/gatherOccurrences';
import {
  applyScenario,
  type ScenarioAssumption,
  type ScenarioInputs,
  type ScenarioResult,
} from '../scenarios/applyScenario';

const router = Router();

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NAME_LENGTH = 255;
const MAX_ASSUMPTIONS = 50;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10));
  const ms = Date.UTC(y, m - 1, d) + days * MS_PER_DAY;
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Validation (pure — exported for unit tests, mirrors validatePlannedEventInput)
// ---------------------------------------------------------------------------

export type NormalizedScenarioInput = {
  name: string;
  assumptions: ScenarioAssumption[];
  horizonDays: number;
  /** null → resolve the household's largest cash currency server-side. */
  currency: string | null;
};

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

function validateAssumption(
  raw: unknown,
  index: number,
): ValidationResult<ScenarioAssumption> {
  if (raw == null || typeof raw !== 'object') {
    return { ok: false, status: 400, error: `assumptions[${index}] must be an object` };
  }
  const a = raw as Record<string, unknown>;
  const kind = String(a.kind ?? '');

  if (kind === 'income_pct' || kind === 'expense_pct') {
    const pct = Number(a.pct);
    if (!Number.isFinite(pct)) {
      return { ok: false, status: 400, error: `assumptions[${index}].pct must be a finite number` };
    }
    // Cannot remove more than 100% of a flow.
    if (pct < -1) {
      return { ok: false, status: 400, error: `assumptions[${index}].pct must be >= -1` };
    }
    return { ok: true, value: { kind, pct } };
  }

  if (kind === 'savings_monthly') {
    const amount = Number(a.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      return { ok: false, status: 400, error: `assumptions[${index}].amount must be a non-negative number` };
    }
    return { ok: true, value: { kind: 'savings_monthly', amount } };
  }

  if (kind === 'one_off') {
    const date = String(a.date ?? '');
    if (!ISO_DATE_RE.test(date)) {
      return { ok: false, status: 400, error: `assumptions[${index}].date must be YYYY-MM-DD` };
    }
    const amount = Number(a.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      return { ok: false, status: 400, error: `assumptions[${index}].amount must be a non-negative number` };
    }
    const direction = String(a.direction ?? '');
    if (direction !== 'in' && direction !== 'out') {
      return { ok: false, status: 400, error: `assumptions[${index}].direction must be 'in' or 'out'` };
    }
    return { ok: true, value: { kind: 'one_off', date, amount, direction } };
  }

  return {
    ok: false,
    status: 400,
    error: `assumptions[${index}].kind must be one of: income_pct, expense_pct, savings_monthly, one_off`,
  };
}

export function validateScenarioInput(
  raw: Record<string, unknown>,
): ValidationResult<NormalizedScenarioInput> {
  const nameRaw = raw.name == null ? '' : String(raw.name).trim();
  if (!nameRaw) {
    return { ok: false, status: 400, error: 'name is required' };
  }
  const name = nameRaw.slice(0, MAX_NAME_LENGTH);

  let assumptionsRaw: unknown[] = [];
  if (raw.assumptions !== undefined) {
    if (!Array.isArray(raw.assumptions)) {
      return { ok: false, status: 400, error: 'assumptions must be an array' };
    }
    assumptionsRaw = raw.assumptions;
  }
  if (assumptionsRaw.length > MAX_ASSUMPTIONS) {
    return { ok: false, status: 400, error: `assumptions cannot exceed ${MAX_ASSUMPTIONS} entries` };
  }
  const assumptions: ScenarioAssumption[] = [];
  for (let i = 0; i < assumptionsRaw.length; i++) {
    const res = validateAssumption(assumptionsRaw[i], i);
    if (!res.ok) return res;
    assumptions.push(res.value);
  }

  let horizonDays = FINANCIAL_SCENARIO_DEFAULT_HORIZON_DAYS;
  if (raw.horizonDays !== undefined) {
    const n = Number(raw.horizonDays);
    if (
      !Number.isInteger(n) ||
      n < MIN_FINANCIAL_SCENARIO_HORIZON_DAYS ||
      n > MAX_FINANCIAL_SCENARIO_HORIZON_DAYS
    ) {
      return {
        ok: false,
        status: 400,
        error: `horizonDays must be an integer between ${MIN_FINANCIAL_SCENARIO_HORIZON_DAYS} and ${MAX_FINANCIAL_SCENARIO_HORIZON_DAYS}`,
      };
    }
    horizonDays = n;
  }

  let currency: string | null = null;
  if (raw.currency !== undefined && raw.currency !== null && raw.currency !== '') {
    const c = String(raw.currency).trim().toUpperCase();
    if (c.length !== 3) {
      return { ok: false, status: 400, error: 'currency must be a 3-letter ISO code' };
    }
    currency = c;
  }

  return { ok: true, value: { name, assumptions, horizonDays, currency } };
}

// ---------------------------------------------------------------------------
// Base-input gathering (DB) → ScenarioInputs for the pure engine
// ---------------------------------------------------------------------------

async function visibleAccountIds(req: Request): Promise<number[]> {
  const accounts = await Account.findAll({
    where: visibleAccountWhere(req),
    attributes: ['id'],
  });
  return accounts.map((a) => a.id);
}

/**
 * Collect the current base inputs the scenario engine needs: opening cash +
 * forecast occurrences (reusing the forecast endpoint's assembly), the
 * safe-to-spend breakdown numbers, and current net worth. Reads only — never
 * mutates transactions or planned events.
 */
async function gatherScenarioBaseInputs(
  req: Request,
  opts: { horizonDays: number; currency: string | null },
): Promise<ScenarioInputs> {
  const { user, household } = currentAuth(req);
  const dateFrom = todayIso();
  const dateTo = addDaysIso(dateFrom, opts.horizonDays);

  const gathered = await gatherForecastInputs(req, {
    dateFrom,
    dateTo,
    currency: opts.currency,
    accountId: null,
    includeRecurring: true,
    balanceAtDate,
  });
  const currency = gathered.currency;

  // Safe-to-spend (uses its own window from settings) for the chosen currency.
  const sts = await computeSafeToSpend({
    userId: user.id,
    householdId: household.id,
    currency,
    asOfDate: dateFrom,
  });
  const settings = await loadSettingsOrDefaults(user.id);

  // Current net worth (CAD total). Net-worth deltas in the scenario are driven
  // by the change in projected cash; this is the baseline they apply to.
  const accountIds = await visibleAccountIds(req);
  const netWorth = await buildNetWorthAt(dateFrom, accountIds);

  return {
    openingBalance: gathered.openingBalance,
    occurrences: gathered.occurrences,
    dateFrom,
    dateTo,
    currency,
    currentCash: sts.breakdown.currentCash,
    upcomingRequiredExpenses: sts.breakdown.upcomingRequiredExpenses,
    requiredSavingsContributions: sts.breakdown.requiredSavingsContributions,
    expectedCreditCardPayments: sts.breakdown.expectedCreditCardPayments,
    minimumBuffer: sts.breakdown.minimumBuffer,
    settings: {
      minimumCashBuffer: settings.minimumCashBuffer,
      safeToSpendWindowDays: settings.safeToSpendWindowDays,
      includeCreditCardBalance: settings.includeCreditCardBalance,
      includeGoalContributions: settings.includeGoalContributions,
    },
    currentNetWorth: netWorth.total,
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

type ScenarioResponse = {
  id: number;
  userId: number;
  householdId: number;
  name: string;
  baseForecastId: number | null;
  assumptions: ScenarioAssumption[];
  horizonDays: number;
  currency: string;
  result: ScenarioResult | null;
  createdAt: string;
  updatedAt: string;
};

function serialize(row: InstanceType<typeof FinancialScenario>): ScenarioResponse {
  return {
    id: row.id,
    userId: row.userId,
    householdId: row.householdId,
    name: row.name,
    baseForecastId: row.baseForecastId,
    assumptions: row.assumptionsJson,
    horizonDays: row.horizonDays,
    currency: row.currency,
    result: row.resultJson ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const rows = await FinancialScenario.findAll({
      where: { ...householdWhere(req) },
      order: [['createdAt', 'DESC']],
    });
    res.json({ data: rows.map(serialize) });
  } catch (e) {
    next(e);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await FinancialScenario.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    // Recompute against current data so a saved scenario reflects today's
    // accounts/events, then cache the fresh result.
    const inputs = await gatherScenarioBaseInputs(req, {
      horizonDays: row.horizonDays,
      currency: row.currency,
    });
    const result = applyScenario(inputs, row.assumptionsJson);
    row.set('resultJson', result);
    await row.save();

    res.json(serialize(row));
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const validated = validateScenarioInput(body);
    if (!validated.ok) {
      res.status(validated.status).json({ error: validated.error });
      return;
    }
    const { name, assumptions, horizonDays, currency } = validated.value;

    const inputs = await gatherScenarioBaseInputs(req, { horizonDays, currency });
    const result = applyScenario(inputs, assumptions);

    const row = await FinancialScenario.create({
      userId: user.id,
      householdId: household.id,
      name,
      baseForecastId: null,
      assumptionsJson: assumptions,
      resultJson: result,
      horizonDays,
      // Persist the resolved currency (input may have been null).
      currency: inputs.currency,
    });

    res.status(201).json(serialize(row));
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await FinancialScenario.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    await row.destroy();
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

export default router;
