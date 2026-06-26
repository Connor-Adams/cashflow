import { Router } from 'express';
import {
  FinancialGoal,
  FINANCIAL_GOAL_STATUSES,
  type FinancialGoalStatus,
} from '../models/FinancialGoal';
import { Account } from '../models';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';
import {
  projectGoal,
  projectGoalAgainstForecast,
  type GoalProjection,
} from '../goals/projection';
import {
  assembleForecast,
  monthlyFreeCashFromOccurrences,
} from '../forecast/assembleForecast';

const router = Router();

// Forecast window used to derive a goal's monthly free cash. 90 days captures
// multiple income/charge cycles so the per-month figure is stable, unlike the
// chart's shorter 30-day default. Normalized back to a monthly number.
const GOAL_FORECAST_WINDOW_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10));
  const ms = Date.UTC(y, m - 1, d) + days * MS_PER_DAY;
  return new Date(ms).toISOString().slice(0, 10);
}

type NormalizedFinancialGoalInput = {
  name: string;
  targetAmount: string;
  currentAmount: string;
  currency: string;
  targetDate: string | null;
  monthlyContribution: string | null;
  linkedAccountId: number | null;
  priority: number;
  status: FinancialGoalStatus;
  notes: string | null;
};

type NormalizedFinancialGoalPatch = Partial<NormalizedFinancialGoalInput>;

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NAME_LENGTH = 255;
const MAX_NOTES_LENGTH = 4096;

function normalizeOptionalString(
  raw: unknown,
  maxLength: number
): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') return String(raw).slice(0, maxLength);
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function normalizeNullableInt(raw: unknown): number | null | 'invalid' {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return 'invalid';
  return n;
}

function normalizeNullableMoney(
  raw: unknown
): string | null | 'invalid' {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 'invalid';
  return n.toFixed(4);
}

/**
 * Pure validator for POST /api/goals bodies. Exported so unit tests can
 * exercise validation without touching the database.
 *
 * Required: name, targetAmount, currency.
 * Optional: currentAmount (default 0), targetDate, monthlyContribution,
 *           linkedAccountId, priority (default 0), status (default 'active'),
 *           notes.
 */
export function validateFinancialGoalInput(
  raw: Record<string, unknown>
): ValidationResult<NormalizedFinancialGoalInput> {
  const name = normalizeOptionalString(raw.name, MAX_NAME_LENGTH);
  if (!name) {
    return { ok: false, status: 400, error: 'name is required' };
  }

  const targetAmountNumber = Number(raw.targetAmount);
  if (!Number.isFinite(targetAmountNumber) || targetAmountNumber <= 0) {
    return {
      ok: false,
      status: 400,
      error: 'targetAmount must be a positive number',
    };
  }

  let currentAmountStr = '0.0000';
  if (raw.currentAmount !== undefined && raw.currentAmount !== null && raw.currentAmount !== '') {
    const currentAmountNumber = Number(raw.currentAmount);
    if (!Number.isFinite(currentAmountNumber) || currentAmountNumber < 0) {
      return {
        ok: false,
        status: 400,
        error: 'currentAmount must be a non-negative number',
      };
    }
    currentAmountStr = currentAmountNumber.toFixed(4);
  }

  const currencyRaw = String(raw.currency ?? '').trim().toUpperCase();
  if (currencyRaw.length !== 3) {
    return {
      ok: false,
      status: 400,
      error: 'currency must be a 3-letter ISO code',
    };
  }

  let targetDate: string | null = null;
  if (raw.targetDate != null && raw.targetDate !== '') {
    const t = String(raw.targetDate);
    if (!ISO_DATE_RE.test(t)) {
      return {
        ok: false,
        status: 400,
        error: 'targetDate must be YYYY-MM-DD',
      };
    }
    targetDate = t;
  }

  const monthlyContributionParsed = normalizeNullableMoney(raw.monthlyContribution);
  if (monthlyContributionParsed === 'invalid') {
    return {
      ok: false,
      status: 400,
      error: 'monthlyContribution must be a non-negative number or null',
    };
  }

  const linkedAccountIdParsed = normalizeNullableInt(raw.linkedAccountId);
  if (linkedAccountIdParsed === 'invalid') {
    return {
      ok: false,
      status: 400,
      error: 'linkedAccountId must be a positive integer or null',
    };
  }

  let priority = 0;
  if (raw.priority !== undefined && raw.priority !== null && raw.priority !== '') {
    const p = Number(raw.priority);
    if (!Number.isInteger(p)) {
      return {
        ok: false,
        status: 400,
        error: 'priority must be an integer',
      };
    }
    priority = p;
  }

  let status: FinancialGoalStatus = 'active';
  if (raw.status != null && raw.status !== '') {
    const statusCandidate = String(raw.status);
    if (
      !(FINANCIAL_GOAL_STATUSES as readonly string[]).includes(statusCandidate)
    ) {
      return {
        ok: false,
        status: 400,
        error: `status must be one of: ${FINANCIAL_GOAL_STATUSES.join(', ')}`,
      };
    }
    status = statusCandidate as FinancialGoalStatus;
  }

  const notes = normalizeOptionalString(raw.notes, MAX_NOTES_LENGTH);

  return {
    ok: true,
    value: {
      name,
      targetAmount: targetAmountNumber.toFixed(4),
      currentAmount: currentAmountStr,
      currency: currencyRaw,
      targetDate,
      monthlyContribution: monthlyContributionParsed,
      linkedAccountId: linkedAccountIdParsed,
      priority,
      status,
      notes,
    },
  };
}

/**
 * Pure validator for PUT /api/goals/:id bodies. Each field is optional;
 * unknown fields are ignored. Returns the partial input.
 */
export function validateFinancialGoalPatch(
  raw: Record<string, unknown>
): ValidationResult<NormalizedFinancialGoalPatch> {
  const out: NormalizedFinancialGoalPatch = {};

  if (raw.name !== undefined) {
    const name = normalizeOptionalString(raw.name, MAX_NAME_LENGTH);
    if (!name) {
      return { ok: false, status: 400, error: 'name cannot be empty' };
    }
    out.name = name;
  }

  if (raw.targetAmount !== undefined) {
    const n = Number(raw.targetAmount);
    if (!Number.isFinite(n) || n <= 0) {
      return {
        ok: false,
        status: 400,
        error: 'targetAmount must be a positive number',
      };
    }
    out.targetAmount = n.toFixed(4);
  }

  if (raw.currentAmount !== undefined) {
    const n = Number(raw.currentAmount);
    if (!Number.isFinite(n) || n < 0) {
      return {
        ok: false,
        status: 400,
        error: 'currentAmount must be a non-negative number',
      };
    }
    out.currentAmount = n.toFixed(4);
  }

  if (raw.currency !== undefined) {
    const currency = String(raw.currency ?? '').trim().toUpperCase();
    if (currency.length !== 3) {
      return {
        ok: false,
        status: 400,
        error: 'currency must be a 3-letter ISO code',
      };
    }
    out.currency = currency;
  }

  if (raw.targetDate !== undefined) {
    if (raw.targetDate === null || raw.targetDate === '') {
      out.targetDate = null;
    } else {
      const t = String(raw.targetDate);
      if (!ISO_DATE_RE.test(t)) {
        return {
          ok: false,
          status: 400,
          error: 'targetDate must be YYYY-MM-DD',
        };
      }
      out.targetDate = t;
    }
  }

  if (raw.monthlyContribution !== undefined) {
    const parsed = normalizeNullableMoney(raw.monthlyContribution);
    if (parsed === 'invalid') {
      return {
        ok: false,
        status: 400,
        error: 'monthlyContribution must be a non-negative number or null',
      };
    }
    out.monthlyContribution = parsed;
  }

  if (raw.linkedAccountId !== undefined) {
    const parsed = normalizeNullableInt(raw.linkedAccountId);
    if (parsed === 'invalid') {
      return {
        ok: false,
        status: 400,
        error: 'linkedAccountId must be a positive integer or null',
      };
    }
    out.linkedAccountId = parsed;
  }

  if (raw.priority !== undefined) {
    const p = Number(raw.priority);
    if (!Number.isInteger(p)) {
      return {
        ok: false,
        status: 400,
        error: 'priority must be an integer',
      };
    }
    out.priority = p;
  }

  if (raw.status !== undefined) {
    const statusCandidate = String(raw.status);
    if (
      !(FINANCIAL_GOAL_STATUSES as readonly string[]).includes(statusCandidate)
    ) {
      return {
        ok: false,
        status: 400,
        error: `status must be one of: ${FINANCIAL_GOAL_STATUSES.join(', ')}`,
      };
    }
    out.status = statusCandidate as FinancialGoalStatus;
  }

  if (raw.notes !== undefined) {
    out.notes = normalizeOptionalString(raw.notes, MAX_NOTES_LENGTH);
  }

  return { ok: true, value: out };
}

type FinancialGoalResponse = {
  id: number;
  userId: number;
  householdId: number;
  name: string;
  targetAmount: string;
  currentAmount: string;
  currency: string;
  targetDate: string | null;
  monthlyContribution: string | null;
  linkedAccountId: number | null;
  priority: number;
  status: FinancialGoalStatus;
  notes: string | null;
  /** Optimistic-lock counter (issue #845); bumps on every save. */
  version: number;
  createdAt: string;
  updatedAt: string;
};

function serializeFinancialGoal(
  row: InstanceType<typeof FinancialGoal>
): FinancialGoalResponse {
  return {
    id: row.id,
    userId: row.userId,
    householdId: row.householdId,
    name: row.name,
    targetAmount: String(row.targetAmount),
    currentAmount: String(row.currentAmount),
    currency: row.currency,
    targetDate: row.targetDate,
    monthlyContribution:
      row.monthlyContribution == null ? null : String(row.monthlyContribution),
    linkedAccountId: row.linkedAccountId,
    priority: row.priority,
    status: row.status,
    notes: row.notes,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Today as YYYY-MM-DD in UTC. */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Verify a linked account (if supplied) belongs to the caller's household.
 */
async function checkAccountInHousehold(
  accountId: number | null,
  householdId: number
): Promise<string | null> {
  if (accountId == null) return null;
  const account = await Account.findOne({
    where: { id: accountId, householdId },
    attributes: ['id'],
  });
  if (!account) {
    return 'linkedAccountId must reference an account in your household';
  }
  return null;
}

router.get('/', async (req, res, next) => {
  try {
    const where: Record<string, unknown> = { ...householdWhere(req) };

    if (req.query.status) {
      const statusRaw = String(req.query.status);
      if ((FINANCIAL_GOAL_STATUSES as readonly string[]).includes(statusRaw)) {
        where.status = statusRaw;
      }
    }
    if (req.query.linkedAccountId) {
      const aid = parseInt(String(req.query.linkedAccountId), 10);
      if (Number.isInteger(aid) && aid > 0) where.linkedAccountId = aid;
    }

    const rows = await FinancialGoal.findAll({
      where,
      // Highest priority first, then alphabetical for stable tiebreaks.
      order: [
        ['priority', 'DESC'],
        ['name', 'ASC'],
      ],
    });

    res.json({ data: rows.map(serializeFinancialGoal) });
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
    const row = await FinancialGoal.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(serializeFinancialGoal(row));
  } catch (e) {
    next(e);
  }
});

router.get('/:id/projection', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await FinancialGoal.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const today = req.query.today && ISO_DATE_RE.test(String(req.query.today))
      ? String(req.query.today)
      : todayISO();

    const projection: GoalProjection = projectGoal({
      targetAmount: String(row.targetAmount),
      currentAmount: String(row.currentAmount),
      targetDate: row.targetDate,
      monthlyContribution:
        row.monthlyContribution == null ? null : String(row.monthlyContribution),
      today,
    });

    // Forecast-grounded validation (#653): derive the household's real
    // forecasted free cash per month and classify the goal against it,
    // instead of trusting the self-reported monthlyContribution. The forecast
    // resolves a SINGLE currency (the household's largest-balance cash
    // currency) — we do NOT force it to the goal's currency. When the goal's
    // currency differs from that forecast currency we surface "can't validate"
    // rather than faking an FX conversion.
    const dateTo = addDaysIso(today, GOAL_FORECAST_WINDOW_DAYS);
    const assembled = await assembleForecast({
      householdId: currentAuth(req).household.id,
      dateFrom: today,
      dateTo,
    });
    const monthlyFreeCash = monthlyFreeCashFromOccurrences(
      assembled.occurrences,
      today,
      dateTo,
    );
    const forecast = projectGoalAgainstForecast({
      targetAmount: String(row.targetAmount),
      currentAmount: String(row.currentAmount),
      targetDate: row.targetDate,
      today,
      goalCurrency: row.currency,
      forecastCurrency: assembled.currency,
      forecastedMonthlyFreeCash: monthlyFreeCash,
    });

    res.json({
      goalId: row.id,
      today,
      ...projection,
      forecast,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = validateFinancialGoalInput(body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const accountErr = await checkAccountInHousehold(
      result.value.linkedAccountId,
      household.id
    );
    if (accountErr) {
      res.status(400).json({ error: accountErr });
      return;
    }

    const row = await FinancialGoal.create({
      userId: user.id,
      householdId: household.id,
      name: result.value.name,
      targetAmount: result.value.targetAmount,
      currentAmount: result.value.currentAmount,
      currency: result.value.currency,
      targetDate: result.value.targetDate,
      monthlyContribution: result.value.monthlyContribution,
      linkedAccountId: result.value.linkedAccountId,
      priority: result.value.priority,
      status: result.value.status,
      notes: result.value.notes,
    });

    res.status(201).json(serializeFinancialGoal(row));
  } catch (e) {
    next(e);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await FinancialGoal.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = validateFinancialGoalPatch(body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const patch = result.value;

    if (patch.linkedAccountId !== undefined) {
      const accountErr = await checkAccountInHousehold(
        patch.linkedAccountId,
        row.householdId
      );
      if (accountErr) {
        res.status(400).json({ error: accountErr });
        return;
      }
    }

    // Targeted column update (issue #845): only the patched columns are written,
    // so a PUT of `status` no longer clobbers a concurrent PUT of `amount` (and
    // vice versa). `version: true` still bumps the lock counter on this update.
    // `patch` already contains exactly the keys the caller sent (the validator
    // skips `undefined` fields), so it maps 1:1 to the columns to write.
    const patchedColumns = patch as Parameters<typeof row.update>[0];
    if (Object.keys(patchedColumns).length > 0) {
      await row.update(patchedColumns);
    }
    res.json(serializeFinancialGoal(row));
  } catch (e) {
    next(e);
  }
});

/**
 * Atomic contribution endpoint (issue #845). Adds a signed delta to
 * `currentAmount` via a single `increment` (SQL `SET current_amount =
 * current_amount + :by`), so concurrent contributions both land — no
 * read-modify-write race, no lost update. Prefer this over client-sent totals.
 *
 * Body: { amount: number } — the delta to apply. Positive adds progress;
 * negative withdraws. The resulting `currentAmount` is clamped to >= 0 so a
 * withdrawal can never drive the goal negative.
 */
router.post('/:id/contribute', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const delta = Number(body.amount);
    if (!Number.isFinite(delta) || delta === 0) {
      res.status(400).json({ error: 'amount must be a non-zero number' });
      return;
    }

    const where = { id, ...householdWhere(req) };

    // Atomic, lock-free progress write. `increment` issues a single UPDATE
    // scoped to the household, so two concurrent +200 / +300 contributions both
    // apply (1000 -> 1500), instead of both reading 1000 and racing to a total.
    await FinancialGoal.increment('currentAmount', { by: delta, where });
    // `increment` returns dialect-shaped metadata, so re-fetch to confirm
    // existence + ownership and to clamp/serialize.
    let row = await FinancialGoal.findOne({ where });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    // Clamp a withdrawal that would otherwise drive progress negative. Use the
    // static `update` (lock-free, scoped by the same WHERE) rather than an
    // instance save, so a concurrent contribution landing between the fetch and
    // the clamp can't trip optimistic locking — then re-fetch the settled row.
    if (Number(row.currentAmount) < 0) {
      await FinancialGoal.update({ currentAmount: '0.0000' }, { where });
      row = await FinancialGoal.findOne({ where });
      if (!row) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
    }

    res.json(serializeFinancialGoal(row));
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
    const row = await FinancialGoal.findOne({
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
