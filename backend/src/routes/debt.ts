import { Router, type Request } from 'express';
import { Op } from 'sequelize';
import {
  Account,
  LiabilityAccount,
  DebtPayoffScenario,
  PlannedEvent,
} from '../models';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';
import { balanceAtDate } from '../networth/balanceAtDate';
import {
  computePayoffPlan,
  comparePayoff,
  PAYOFF_STRATEGIES,
  type PayoffStrategy,
  type PayoffDebtInput,
  type PayoffPlan,
} from '../debt/payoffPlan';

const router = Router();

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NAME_LENGTH = 255;
// Liability account types — must match networth/accountKind.ts LIABILITY_TYPES.
const LIABILITY_TYPES = new Set(['credit_card', 'loan', 'mortgage']);
// How many months of debt payments to materialize into the forecast when
// feedForecast is requested. Bounded so we never project an unrealistic
// horizon, and capped further by the plan's own length.
const FORECAST_HORIZON_MONTHS = 60;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

// ---------------------------------------------------------------------------
// Liability assembly
// ---------------------------------------------------------------------------

type LiabilityRow = {
  accountId: number;
  name: string;
  accountType: string;
  currency: string;
  /** Amount currently owed, as a positive number. */
  balance: number;
  interestRate: number;
  minimumPayment: number;
  statementBalance: number | null;
  dueDay: number | null;
};

/**
 * The owed balance for a liability account. We prefer the explicit
 * `statementBalance` override when set; otherwise we derive it from the
 * transaction-stream balance via balanceAtDate. Liability balances are
 * negative (money owed), so we surface the magnitude as a positive "owed"
 * figure for the planner.
 */
async function owedBalance(
  account: InstanceType<typeof Account>,
  profile: InstanceType<typeof LiabilityAccount> | null,
  asOf: string,
): Promise<number> {
  if (profile && profile.statementBalance != null) {
    return Math.abs(Number(profile.statementBalance));
  }
  const balances = await balanceAtDate(account, asOf);
  const ccy = account.defaultCurrency ?? 'CAD';
  const match = balances.find((b) => b.currency === ccy) ?? balances[0];
  const raw = match ? match.amount : 0;
  // Owed is the magnitude of a negative balance; a positive balance (overpaid)
  // means nothing is owed.
  return raw < 0 ? Math.abs(raw) : 0;
}

/**
 * Assemble the household's liability accounts joined with their liability
 * profiles and derived owed balances.
 */
async function loadLiabilities(req: Request, asOf: string): Promise<LiabilityRow[]> {
  const accounts = await Account.findAll({
    where: {
      ...householdWhere(req),
      accountType: { [Op.in]: Array.from(LIABILITY_TYPES) },
    },
    order: [['id', 'ASC']],
  });
  if (accounts.length === 0) return [];

  const profiles = await LiabilityAccount.findAll({
    where: { accountId: { [Op.in]: accounts.map((a) => a.id) } },
  });
  const profileByAccount = new Map<number, InstanceType<typeof LiabilityAccount>>();
  for (const p of profiles) profileByAccount.set(p.accountId, p);

  const rows: LiabilityRow[] = [];
  for (const account of accounts) {
    const profile = profileByAccount.get(account.id) ?? null;
    const balance = await owedBalance(account, profile, asOf);
    rows.push({
      accountId: account.id,
      name: account.name,
      accountType: account.accountType,
      currency: account.defaultCurrency ?? 'CAD',
      balance,
      interestRate: profile ? Number(profile.interestRate) : 0,
      minimumPayment: profile ? Number(profile.minimumPayment) : 0,
      statementBalance: profile && profile.statementBalance != null ? Number(profile.statementBalance) : null,
      dueDay: profile ? profile.dueDay : null,
    });
  }
  return rows;
}

/** Map assembled liabilities into the payoff engine's debt inputs (owed > 0). */
function toDebtInputs(liabilities: LiabilityRow[]): PayoffDebtInput[] {
  return liabilities
    .filter((l) => l.balance > 0)
    .map((l) => ({
      id: l.accountId,
      name: l.name,
      balance: l.balance,
      apr: l.interestRate,
      minimumPayment: l.minimumPayment,
    }));
}

// ---------------------------------------------------------------------------
// GET /api/debt — overview + default comparison
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const asOf = todayIso();
    const liabilities = await loadLiabilities(req, asOf);

    let extraMonthlyPayment = 0;
    if (req.query.extraMonthlyPayment !== undefined && req.query.extraMonthlyPayment !== '') {
      const n = Number(req.query.extraMonthlyPayment);
      if (Number.isFinite(n) && n >= 0) extraMonthlyPayment = n;
    }

    const debts = toDebtInputs(liabilities);
    const comparison = debts.length > 0 ? comparePayoff(debts, extraMonthlyPayment, asOf) : null;

    const currency = liabilities[0]?.currency ?? 'CAD';
    const totalOwed = liabilities.reduce((acc, l) => acc + l.balance, 0);
    const totalMinimum = liabilities.reduce((acc, l) => acc + l.minimumPayment, 0);

    res.json({
      currency,
      totalOwed: Math.round(totalOwed * 100) / 100,
      totalMinimumPayment: Math.round(totalMinimum * 100) / 100,
      extraMonthlyPayment,
      liabilities,
      comparison,
    });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/debt/accounts/:accountId — upsert a liability profile
// ---------------------------------------------------------------------------

type ProfileInput = {
  interestRate: number;
  minimumPayment: number;
  statementBalance: number | null;
  dueDay: number | null;
};

function validateProfileInput(raw: Record<string, unknown>): ValidationResult<ProfileInput> {
  const interestRate = Number(raw.interestRate ?? 0);
  if (!Number.isFinite(interestRate) || interestRate < 0 || interestRate > 999) {
    return { ok: false, status: 400, error: 'interestRate must be a percent between 0 and 999' };
  }
  const minimumPayment = Number(raw.minimumPayment ?? 0);
  if (!Number.isFinite(minimumPayment) || minimumPayment < 0) {
    return { ok: false, status: 400, error: 'minimumPayment must be a non-negative number' };
  }

  let statementBalance: number | null = null;
  if (raw.statementBalance != null && raw.statementBalance !== '') {
    const n = Number(raw.statementBalance);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, status: 400, error: 'statementBalance must be a non-negative number' };
    }
    statementBalance = n;
  }

  let dueDay: number | null = null;
  if (raw.dueDay != null && raw.dueDay !== '') {
    const n = Number(raw.dueDay);
    if (!Number.isInteger(n) || n < 1 || n > 31) {
      return { ok: false, status: 400, error: 'dueDay must be an integer between 1 and 31' };
    }
    dueDay = n;
  }

  return { ok: true, value: { interestRate, minimumPayment, statementBalance, dueDay } };
}

function serializeProfile(
  row: InstanceType<typeof LiabilityAccount>,
): {
  accountId: number;
  interestRate: number;
  minimumPayment: number;
  statementBalance: number | null;
  dueDay: number | null;
} {
  return {
    accountId: row.accountId,
    interestRate: Number(row.interestRate),
    minimumPayment: Number(row.minimumPayment),
    statementBalance: row.statementBalance != null ? Number(row.statementBalance) : null,
    dueDay: row.dueDay,
  };
}

router.put('/accounts/:accountId', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const accountId = parseInt(req.params.accountId, 10);
    if (!Number.isInteger(accountId) || accountId < 1) {
      res.status(400).json({ error: 'Invalid accountId' });
      return;
    }

    const account = await Account.findOne({ where: { id: accountId, ...householdWhere(req) } });
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    if (!LIABILITY_TYPES.has(account.accountType)) {
      res.status(400).json({
        error: `account_type must be a liability kind (${Array.from(LIABILITY_TYPES).join(', ')})`,
      });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = validateProfileInput(body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const existing = await LiabilityAccount.findOne({ where: { accountId } });
    let row: InstanceType<typeof LiabilityAccount>;
    if (existing) {
      existing.set('interestRate', result.value.interestRate.toFixed(4));
      existing.set('minimumPayment', result.value.minimumPayment.toFixed(4));
      existing.set(
        'statementBalance',
        result.value.statementBalance == null ? null : result.value.statementBalance.toFixed(4),
      );
      existing.set('dueDay', result.value.dueDay);
      await existing.save();
      row = existing;
    } else {
      row = await LiabilityAccount.create({
        accountId,
        householdId: household.id,
        interestRate: result.value.interestRate.toFixed(4),
        minimumPayment: result.value.minimumPayment.toFixed(4),
        statementBalance:
          result.value.statementBalance == null ? null : result.value.statementBalance.toFixed(4),
        dueDay: result.value.dueDay,
      });
    }

    res.json(serializeProfile(row));
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// Scenario validation + serialization
// ---------------------------------------------------------------------------

type ScenarioInput = {
  name: string;
  strategy: PayoffStrategy;
  extraMonthlyPayment: number;
  customOrder: number[] | null;
  feedForecast: boolean;
  startDate: string;
};

function validateScenarioInput(raw: Record<string, unknown>): ValidationResult<ScenarioInput> {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) {
    return { ok: false, status: 400, error: 'name is required' };
  }
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, status: 400, error: `name must be <= ${MAX_NAME_LENGTH} characters` };
  }

  const strategyRaw = String(raw.strategy ?? '');
  if (!(PAYOFF_STRATEGIES as readonly string[]).includes(strategyRaw)) {
    return {
      ok: false,
      status: 400,
      error: `strategy must be one of: ${PAYOFF_STRATEGIES.join(', ')}`,
    };
  }
  const strategy = strategyRaw as PayoffStrategy;

  let extraMonthlyPayment = 0;
  if (raw.extraMonthlyPayment != null && raw.extraMonthlyPayment !== '') {
    const n = Number(raw.extraMonthlyPayment);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, status: 400, error: 'extraMonthlyPayment must be a non-negative number' };
    }
    extraMonthlyPayment = n;
  }

  let customOrder: number[] | null = null;
  if (raw.customOrder != null) {
    if (!Array.isArray(raw.customOrder)) {
      return { ok: false, status: 400, error: 'customOrder must be an array of account ids' };
    }
    const ids: number[] = [];
    for (const v of raw.customOrder) {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) {
        return { ok: false, status: 400, error: 'customOrder must contain positive integer account ids' };
      }
      ids.push(n);
    }
    customOrder = ids;
  }

  const feedForecast = raw.feedForecast === true || raw.feedForecast === 'true';

  let startDate = todayIso();
  if (raw.startDate != null && raw.startDate !== '') {
    const s = String(raw.startDate);
    if (!ISO_DATE_RE.test(s)) {
      return { ok: false, status: 400, error: 'startDate must be YYYY-MM-DD' };
    }
    startDate = s;
  }

  return {
    ok: true,
    value: { name, strategy, extraMonthlyPayment, customOrder, feedForecast, startDate },
  };
}

function serializeScenario(
  row: InstanceType<typeof DebtPayoffScenario>,
): {
  id: number;
  householdId: number;
  userId: number | null;
  name: string;
  strategy: string;
  extraMonthlyPayment: string;
  payloadJson: string | null;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: row.id,
    householdId: row.householdId,
    userId: row.userId,
    name: row.name,
    strategy: row.strategy,
    extraMonthlyPayment: String(row.extraMonthlyPayment),
    payloadJson: row.payloadJson,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Compute a payoff plan for a scenario against the current liabilities. The
 * `customOrder` (for custom strategy) is read from the scenario payload.
 */
function planForScenario(
  liabilities: LiabilityRow[],
  strategy: PayoffStrategy,
  extraMonthlyPayment: number,
  customOrder: number[] | null,
  startDate: string,
): PayoffPlan {
  return computePayoffPlan({
    debts: toDebtInputs(liabilities),
    strategy,
    extraMonthlyPayment,
    customOrder: customOrder ?? undefined,
    startDate,
  });
}

/**
 * Materialize (or re-sync) the scenario's monthly debt payments as a single
 * recurring `debt_payment` PlannedEvent so the cashflow forecast projects the
 * outflow. The funding model keeps the total monthly outflow constant (sum of
 * minimums + extra) until debts clear, so one recurring event with that amount
 * faithfully represents the household-level cash impact.
 *
 * Idempotent: any prior debt-sourced planned events for the household are
 * removed first, so re-saving a scenario does not accumulate duplicates.
 */
async function syncForecastDebtEvent(
  householdId: number,
  userId: number,
  liabilities: LiabilityRow[],
  plan: PayoffPlan,
  scenario: InstanceType<typeof DebtPayoffScenario>,
  startDate: string,
): Promise<void> {
  // Clear prior debt-sourced events for this household (single-scenario feed).
  await PlannedEvent.destroy({ where: { householdId, source: 'debt' } });

  const monthlyBudget =
    liabilities.reduce((acc, l) => (l.balance > 0 ? acc + l.minimumPayment : acc), 0) +
    Number(scenario.extraMonthlyPayment);
  if (monthlyBudget <= 0 || plan.totalMonths <= 0) return;

  const months = Math.min(plan.totalMonths, FORECAST_HORIZON_MONTHS);
  const currency = liabilities.find((l) => l.balance > 0)?.currency ?? 'CAD';

  await PlannedEvent.create({
    userId,
    householdId,
    accountId: null,
    type: 'debt_payment',
    name: `Debt payoff: ${scenario.name}`,
    amount: monthlyBudget.toFixed(4),
    currency,
    expectedDate: startDate,
    recurrenceRule: `FREQ=MONTHLY;COUNT=${months}`,
    source: 'debt',
    status: 'planned',
    linkedTransactionId: null,
    notes: `[debt-scenario:${scenario.id}]`,
  });
}

// ---------------------------------------------------------------------------
// POST /api/debt/scenarios — create + compute
// ---------------------------------------------------------------------------

router.post('/scenarios', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = validateScenarioInput(body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const asOf = todayIso();
    const liabilities = await loadLiabilities(req, asOf);

    const payload = JSON.stringify({
      order: result.value.customOrder ?? null,
      liabilities: liabilities.map((l) => ({
        accountId: l.accountId,
        name: l.name,
        balance: l.balance,
        apr: l.interestRate,
        minimumPayment: l.minimumPayment,
      })),
    });

    const scenario = await DebtPayoffScenario.create({
      householdId: household.id,
      userId: user.id,
      name: result.value.name,
      strategy: result.value.strategy,
      extraMonthlyPayment: result.value.extraMonthlyPayment.toFixed(4),
      payloadJson: payload,
    });

    const plan = planForScenario(
      liabilities,
      result.value.strategy,
      result.value.extraMonthlyPayment,
      result.value.customOrder,
      result.value.startDate,
    );

    if (result.value.feedForecast) {
      await syncForecastDebtEvent(
        household.id,
        user.id,
        liabilities,
        plan,
        scenario,
        result.value.startDate,
      );
    }

    res.status(201).json({ scenario: serializeScenario(scenario), plan });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// GET /api/debt/scenarios — list
// ---------------------------------------------------------------------------

router.get('/scenarios', async (req, res, next) => {
  try {
    const rows = await DebtPayoffScenario.findAll({
      where: { ...householdWhere(req) },
      order: [['createdAt', 'DESC']],
    });
    res.json({ data: rows.map(serializeScenario) });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// GET /api/debt/scenarios/:id — fetch + recompute
// ---------------------------------------------------------------------------

router.get('/scenarios/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const scenario = await DebtPayoffScenario.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!scenario) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    let customOrder: number[] | null = null;
    if (scenario.payloadJson) {
      try {
        const parsed = JSON.parse(scenario.payloadJson) as { order?: unknown };
        if (Array.isArray(parsed.order)) {
          customOrder = parsed.order.filter((v): v is number => Number.isInteger(v));
        }
      } catch {
        customOrder = null;
      }
    }

    const asOf = todayIso();
    const liabilities = await loadLiabilities(req, asOf);
    const plan = planForScenario(
      liabilities,
      scenario.strategy,
      Number(scenario.extraMonthlyPayment),
      customOrder,
      asOf,
    );

    res.json({ scenario: serializeScenario(scenario), plan, liabilities });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/debt/scenarios/:id
// ---------------------------------------------------------------------------

router.delete('/scenarios/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const scenario = await DebtPayoffScenario.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!scenario) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    await scenario.destroy();
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

export default router;
