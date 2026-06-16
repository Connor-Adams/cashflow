/**
 * Financial scenario planner routes (issue #213).
 *
 * Endpoint surface:
 *   GET    /api/financial-scenarios          — list scenarios for the household
 *   POST   /api/financial-scenarios          — create a scenario
 *   GET    /api/financial-scenarios/:id      — fetch one scenario
 *   PATCH  /api/financial-scenarios/:id      — update name / assumptions
 *   DELETE /api/financial-scenarios/:id      — delete a scenario
 *   POST   /api/financial-scenarios/:id/recompute — re-run the forecast engine
 *                                                   and persist the result_json
 *
 * Isolation: all reads/writes go through householdWhere() so cross-household
 * access is impossible regardless of the :id value.
 *
 * NOTE on debt-payoff assumptions: the `debt_payoff` assumption type is NOT
 * supported in this version — it depends on the debt planner (issue #202)
 * which is still open. The validation below rejects `debt_payoff` with a
 * 400 so clients get a clear error instead of silent data corruption. When
 * #202 ships, add 'debt_payoff' to ASSUMPTION_TYPES and implement the
 * expansion in runScenario.ts.
 *
 * NOTE on opportunity-cost / future-value (issue #252): because
 * runScenario() returns the daily forecast series, the UI could compute
 * opportunity cost of a lump-sum as the future value of the cash freed up
 * (or consumed). This route surfaces the raw data needed for that — issue
 * #252 can be resolved without a schema change once a future-value helper
 * is added.
 */
import { Router } from 'express';
import { Op, type WhereOptions } from 'sequelize';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';
import { FinancialScenario } from '../models/FinancialScenario';
import { Account, PlannedEvent, Transaction } from '../models';
import {
  runScenario,
  addDaysIso,
  type ScenarioAssumption,
  type AssumptionsJson,
  type AssumptionType,
  type AssumptionRecurrence,
} from '../scenarios/runScenario';
import {
  type ForecastOccurrence,
} from '../forecast/buildForecast';
import { expandRecurrence, type PlannedEventLike } from '../forecast/expandRecurrence';
import { resolveForecastCurrency } from '../forecast/gatherOccurrences';
import { balanceAtDate } from '../networth/balanceAtDate';
import { detectRecurring, type RecurringInputTxn } from './recurring';
import { num } from '../util/numbers';
import { classifyPositiveFlow } from '../summary/classifyTransactionFlow';

const router = Router();

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NAME_LENGTH = 255;
const MAX_OVERRIDES = 50;
const VALID_BASELINE_DAYS = new Set([30, 60, 90]);
const VALID_ASSUMPTION_TYPES: AssumptionType[] = ['income', 'expense', 'savings', 'one_off'];
const VALID_RECURRENCES: AssumptionRecurrence[] = ['weekly', 'biweekly', 'monthly'];

// Match the forecast route's defaults.
const DEFAULT_BASELINE_DAYS = 30;
const FORECAST_EXCLUDED_TYPES = new Set(['investment']);
const RECURRING_LOOKBACK_DAYS = 180;
const RECURRING_MIN_OCCURRENCES = 3;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

function validateAssumption(
  raw: unknown,
  idx: number,
): ValidationResult<ScenarioAssumption> {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, status: 400, error: `overrides[${idx}] must be an object` };
  }
  const obj = raw as Record<string, unknown>;

  // label
  const label = typeof obj.label === 'string' ? obj.label.trim() : null;
  if (!label || label.length === 0) {
    return { ok: false, status: 400, error: `overrides[${idx}].label is required` };
  }
  if (label.length > 200) {
    return { ok: false, status: 400, error: `overrides[${idx}].label exceeds 200 chars` };
  }

  // type
  const type = typeof obj.type === 'string' ? obj.type : null;
  if (!type || !(VALID_ASSUMPTION_TYPES as string[]).includes(type)) {
    return {
      ok: false,
      status: 400,
      error: `overrides[${idx}].type must be one of: ${VALID_ASSUMPTION_TYPES.join(', ')}`,
    };
  }

  // amount
  const amount = Number(obj.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    return {
      ok: false,
      status: 400,
      error: `overrides[${idx}].amount must be a non-negative number`,
    };
  }

  // startDate
  if (typeof obj.startDate !== 'string' || !ISO_DATE_RE.test(obj.startDate)) {
    return {
      ok: false,
      status: 400,
      error: `overrides[${idx}].startDate must be YYYY-MM-DD`,
    };
  }

  // endDate (optional)
  if (obj.endDate != null && obj.endDate !== '') {
    if (typeof obj.endDate !== 'string' || !ISO_DATE_RE.test(obj.endDate)) {
      return {
        ok: false,
        status: 400,
        error: `overrides[${idx}].endDate must be YYYY-MM-DD when provided`,
      };
    }
  }

  // recurrence (optional)
  if (obj.recurrence != null && obj.recurrence !== '') {
    if (!(VALID_RECURRENCES as unknown[]).includes(obj.recurrence)) {
      return {
        ok: false,
        status: 400,
        error: `overrides[${idx}].recurrence must be one of: ${VALID_RECURRENCES.join(', ')}`,
      };
    }
  }

  // direction (optional, only for one_off)
  if (obj.direction != null) {
    if (obj.direction !== 'in' && obj.direction !== 'out') {
      return {
        ok: false,
        status: 400,
        error: `overrides[${idx}].direction must be 'in' or 'out'`,
      };
    }
  }

  return {
    ok: true,
    value: {
      label,
      type: type as AssumptionType,
      amount,
      startDate: obj.startDate,
      endDate: typeof obj.endDate === 'string' ? obj.endDate : null,
      recurrence: typeof obj.recurrence === 'string' ? (obj.recurrence as AssumptionRecurrence) : null,
      direction: obj.direction === 'in' ? 'in' : obj.direction === 'out' ? 'out' : null,
    },
  };
}

function validateCreateBody(
  raw: unknown,
): ValidationResult<{ name: string; assumptionsJson: AssumptionsJson }> {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, status: 400, error: 'Request body must be an object' };
  }
  const body = raw as Record<string, unknown>;

  const name =
    typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME_LENGTH) : null;
  if (!name || name.length === 0) {
    return { ok: false, status: 400, error: 'name is required' };
  }

  const overridesRaw = body.overrides;
  if (!Array.isArray(overridesRaw)) {
    return { ok: false, status: 400, error: 'overrides must be an array' };
  }
  if (overridesRaw.length > MAX_OVERRIDES) {
    return {
      ok: false,
      status: 400,
      error: `overrides array cannot exceed ${MAX_OVERRIDES} items`,
    };
  }

  const overrides: ScenarioAssumption[] = [];
  for (let i = 0; i < overridesRaw.length; i++) {
    const v = validateAssumption(overridesRaw[i], i);
    if (!v.ok) return v;
    overrides.push(v.value);
  }

  // baselineDays (optional)
  let baselineDays: 30 | 60 | 90 = DEFAULT_BASELINE_DAYS;
  if (body.baselineDays != null) {
    const parsed = Number(body.baselineDays);
    if (!VALID_BASELINE_DAYS.has(parsed)) {
      return {
        ok: false,
        status: 400,
        error: 'baselineDays must be 30, 60, or 90',
      };
    }
    baselineDays = parsed as 30 | 60 | 90;
  }

  return {
    ok: true,
    value: {
      name,
      assumptionsJson: { name, baselineDays, overrides },
    },
  };
}

function validatePatchBody(raw: unknown): ValidationResult<{
  name?: string;
  assumptionsJson?: AssumptionsJson;
}> {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, status: 400, error: 'Request body must be an object' };
  }
  const body = raw as Record<string, unknown>;
  const patch: { name?: string; assumptionsJson?: AssumptionsJson } = {};

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME_LENGTH) : null;
    if (!name || name.length === 0) {
      return { ok: false, status: 400, error: 'name cannot be empty' };
    }
    patch.name = name;
  }

  // Allow partial assumptions update: if overrides or baselineDays are given,
  // rebuild the full assumptionsJson. Otherwise assume the body holds the
  // full assumptions object if `overrides` is present.
  if (body.overrides !== undefined || body.baselineDays !== undefined) {
    const result = validateCreateBody(body);
    if (!result.ok) return result;
    patch.assumptionsJson = result.value.assumptionsJson;
    if (!patch.name) patch.name = result.value.name;
  }

  return { ok: true, value: patch };
}

// ---------------------------------------------------------------------------
// Forecast engine helpers (adapted from routes/forecast.ts)
// ---------------------------------------------------------------------------

/** Infer direction from PlannedEvent type — mirrors forecast.ts logic. */
function directionOfPlannedEvent(
  type: PlannedEvent['type'],
): ForecastOccurrence['direction'] {
  switch (type) {
    case 'income':
      return 'in';
    case 'expense':
    case 'debt_payment':
    case 'savings':
      return 'out';
    case 'transfer':
    case 'settlement':
      return 'neutral';
  }
}

/**
 * Build the baseline forecast input for a given household + currency +
 * date window. This is a lightweight copy of the logic in forecast.ts
 * that we need here to run the scenario comparison.
 */
async function buildBaselineInput(
  householdId: number,
  currency: string,
  dateFrom: string,
  dateTo: string,
) {
  // Eligible accounts (non-investment, not closed before the window).
  const allAccounts = await Account.findAll({ where: { householdId } });
  const eligible = allAccounts.filter((a) => {
    if (FORECAST_EXCLUDED_TYPES.has(a.accountType)) return false;
    if (a.closedAt && a.closedAt <= dateFrom) return false;
    return true;
  });

  // Opening balance in the requested currency.
  let openingBalance = 0;
  for (const acc of eligible) {
    const bals = await balanceAtDate(acc, dateFrom);
    for (const { currency: ccy, amount } of bals) {
      if (ccy === currency) openingBalance += amount;
    }
  }

  // PlannedEvent occurrences in the window.
  const eventWhere: WhereOptions = {
    householdId,
    kind: 'planned',
    currency,
    status: 'planned',
    expectedDate: { [Op.lte]: dateTo },
  };
  const plannedRows = await PlannedEvent.findAll({
    where: eventWhere,
    order: [['expectedDate', 'ASC']],
  });

  const occurrences: ForecastOccurrence[] = [];
  for (const row of plannedRows) {
    const eventLike: PlannedEventLike = {
      id: row.id,
      expectedDate: row.expectedDate,
      recurrenceRule: row.recurrenceRule,
      status: row.status,
    };
    const rowOccs = expandRecurrence(eventLike, dateFrom, dateTo);
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) continue;
    const direction = directionOfPlannedEvent(row.type);
    for (const occ of rowOccs) {
      occurrences.push({
        date: occ.date,
        amount,
        direction,
        sourceType: 'planned_event',
        sourceId: row.id,
        sourceName: row.name,
        accountId: row.accountId,
      });
    }
  }

  // Recurring detection — same logic as forecast.ts.
  const txnSince = addDaysIso(dateFrom, -RECURRING_LOOKBACK_DAYS);
  const txnWhere: WhereOptions = {
    householdId,
    date: { [Op.gte]: txnSince, [Op.lt]: dateFrom },
    currency,
  };
  const txnRows = await Transaction.findAll({
    where: txnWhere,
    attributes: ['date', 'currency', 'amount', 'merchantRaw', 'merchantClean', 'finalCategory'],
    raw: true,
  });

  type RawRow = {
    date: string;
    currency: string;
    amount: unknown;
    merchantRaw: string | null;
    merchantClean: string | null;
    finalCategory: string | null;
  };

  const candidates: RecurringInputTxn[] = [];
  for (const row of txnRows as unknown as RawRow[]) {
    const amount = num(row.amount);
    if (amount == null || amount >= 0) continue;
    if (
      classifyPositiveFlow({
        merchantRaw: row.merchantRaw,
        merchantClean: row.merchantClean,
        category: row.finalCategory,
      }) === 'payment'
    )
      continue;
    const merchant = (row.merchantClean ?? '').trim() || (row.merchantRaw ?? '').trim();
    if (!merchant) continue;
    candidates.push({ merchant, amount, currency: row.currency, date: row.date, category: row.finalCategory });
  }

  const recurringItems = detectRecurring(candidates, { minOccurrences: RECURRING_MIN_OCCURRENCES });
  const plannedNameKeys = new Set(plannedRows.map((r) => r.name.trim().toLowerCase()));

  let recurringIdCounter = 1;
  for (const item of recurringItems) {
    if (plannedNameKeys.has(item.merchant.trim().toLowerCase())) continue;
    const stepDays = item.cadence === 'weekly' ? 7 : 30;
    let cursor = item.nextExpected;
    while (cursor < dateFrom) cursor = addDaysIso(cursor, stepDays);
    const id = recurringIdCounter++;
    while (cursor <= dateTo) {
      occurrences.push({
        date: cursor,
        amount: item.avgAmount,
        direction: 'out',
        sourceType: 'recurring_detection',
        sourceId: id,
        sourceName: item.merchant,
        accountId: null,
      });
      cursor = addDaysIso(cursor, stepDays);
    }
  }

  return {
    openingBalance,
    occurrences,
    dateFrom,
    dateTo,
    currency,
  };
}

/**
 * Accounts the scenario planner treats as non-cash when picking a default
 * currency: investments and credit cards. This is a THIRD distinct exclusion
 * set — the forecast route excludes only `investment`, safe-to-spend also
 * excludes `loan` — which is exactly why `resolveForecastCurrency` takes the
 * set as a parameter instead of hard-coding one.
 */
const SCENARIO_CCY_EXCLUDED_TYPES: ReadonlySet<string> = new Set([
  'investment',
  'credit_card',
]);

/**
 * Resolve the best default currency for a household (largest absolute cash
 * balance, CAD on ties, CAD fallback). Delegates to the shared
 * `resolveForecastCurrency` (the canonical largest-abs/CAD-tiebreak algorithm
 * from #404) with the scenario planner's own exclusion set.
 */
export async function resolveHouseholdCurrency(
  householdId: number,
  asOfDate: string,
): Promise<string> {
  return resolveForecastCurrency(householdId, asOfDate, SCENARIO_CCY_EXCLUDED_TYPES);
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

function serialize(row: FinancialScenario) {
  return {
    id: row.id,
    householdId: row.householdId,
    userId: row.userId,
    name: row.name,
    assumptionsJson: row.assumptionsJson,
    resultJson: row.resultJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/financial-scenarios
 * List all scenarios for the authenticated household, ordered newest-first.
 */
router.get('/', async (req, res, next) => {
  try {
    const rows = await FinancialScenario.findAll({
      where: householdWhere(req),
      order: [['createdAt', 'DESC']],
    });
    res.json({ data: rows.map(serialize) });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/financial-scenarios
 * Create a new scenario. Immediately runs the forecast engine and stores
 * result_json so the UI can render deltas without a follow-up request.
 */
router.post('/', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const { user } = currentAuth(req);

    const validation = validateCreateBody(req.body as unknown);
    if (!validation.ok) {
      res.status(validation.status).json({ error: validation.error });
      return;
    }
    const { name, assumptionsJson } = validation.value;

    // Run the forecast immediately so result_json is populated on creation.
    const dateFrom = todayIso();
    const baselineDays = assumptionsJson.baselineDays ?? DEFAULT_BASELINE_DAYS;
    const dateTo = addDaysIso(dateFrom, baselineDays);
    const currency = await resolveHouseholdCurrency(household.id, dateFrom);
    const baselineInput = await buildBaselineInput(household.id, currency, dateFrom, dateTo);
    const resultJson = runScenario(baselineInput, assumptionsJson.overrides);

    const row = await FinancialScenario.create({
      householdId: household.id,
      userId: user.id,
      name,
      assumptionsJson,
      resultJson,
    });

    res.status(201).json(serialize(row));
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/financial-scenarios/:id
 * Fetch a single scenario. Returns 404 when the id doesn't belong to the
 * authenticated household.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'id must be a positive integer' });
      return;
    }
    const row = await FinancialScenario.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Scenario not found' });
      return;
    }
    res.json(serialize(row));
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /api/financial-scenarios/:id
 * Update name and/or assumptions. When assumptions change, result_json is
 * recomputed automatically.
 */
router.patch('/:id', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'id must be a positive integer' });
      return;
    }
    const row = await FinancialScenario.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Scenario not found' });
      return;
    }

    const validation = validatePatchBody(req.body as unknown);
    if (!validation.ok) {
      res.status(validation.status).json({ error: validation.error });
      return;
    }
    const patch = validation.value;

    // Recompute result_json when assumptions changed.
    if (patch.assumptionsJson) {
      const dateFrom = todayIso();
      const baselineDays = patch.assumptionsJson.baselineDays ?? DEFAULT_BASELINE_DAYS;
      const dateTo = addDaysIso(dateFrom, baselineDays);
      const currency = await resolveHouseholdCurrency(household.id, dateFrom);
      const baselineInput = await buildBaselineInput(household.id, currency, dateFrom, dateTo);
      patch.assumptionsJson.name = patch.name ?? row.name;
      row.resultJson = runScenario(baselineInput, patch.assumptionsJson.overrides);
      row.assumptionsJson = patch.assumptionsJson;
    }

    if (patch.name !== undefined) row.name = patch.name;

    await row.save();
    res.json(serialize(row));
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /api/financial-scenarios/:id
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'id must be a positive integer' });
      return;
    }
    const row = await FinancialScenario.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Scenario not found' });
      return;
    }
    await row.destroy();
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/financial-scenarios/:id/recompute
 * Re-run the forecast engine against the current assumptions and persist
 * the result. Returns the full updated row.
 *
 * The forecast window uses today as the start date. The baseline days come
 * from the stored assumptions_json.baselineDays (defaulting to 30).
 */
router.post('/:id/recompute', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'id must be a positive integer' });
      return;
    }
    const row = await FinancialScenario.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Scenario not found' });
      return;
    }

    const dateFrom = todayIso();
    const baselineDays = row.assumptionsJson.baselineDays ?? DEFAULT_BASELINE_DAYS;
    const dateTo = addDaysIso(dateFrom, baselineDays);
    const currency = await resolveHouseholdCurrency(household.id, dateFrom);
    const baselineInput = await buildBaselineInput(household.id, currency, dateFrom, dateTo);
    row.resultJson = runScenario(baselineInput, row.assumptionsJson.overrides);
    await row.save();

    res.json(serialize(row));
  } catch (e) {
    next(e);
  }
});

export default router;
