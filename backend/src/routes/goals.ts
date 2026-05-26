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
  requiredMonthlyContributionsByCurrency,
  type GoalSnapshot,
} from '../goals/projection';

const router = Router();

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NAME_LENGTH = 255;
const MAX_NOTES_LENGTH = 4096;

type NormalizedGoalInput = {
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

type NormalizedGoalPatch = Partial<NormalizedGoalInput>;

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

function normalizeOptionalString(raw: unknown, maxLength: number): string | null {
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

function normalizeAmount(raw: unknown, allowZero = true): string | 'invalid' {
  if (raw == null || raw === '') return 'invalid';
  const n = Number(raw);
  if (!Number.isFinite(n)) return 'invalid';
  if (n < 0) return 'invalid';
  if (!allowZero && n === 0) return 'invalid';
  return n.toFixed(4);
}

/**
 * Pure validator for POST /api/goals bodies. Exported so unit tests can
 * exercise validation without touching the database.
 *
 * Required: name, targetAmount (>0), currency.
 * Optional: currentAmount, targetDate (YYYY-MM-DD), monthlyContribution,
 *           linkedAccountId, priority (>=0), status, notes.
 */
export function validateGoalInput(
  raw: Record<string, unknown>,
): ValidationResult<NormalizedGoalInput> {
  const name = normalizeOptionalString(raw.name, MAX_NAME_LENGTH);
  if (!name) {
    return { ok: false, status: 400, error: 'name is required' };
  }

  if (raw.targetAmount == null || raw.targetAmount === '') {
    return { ok: false, status: 400, error: 'targetAmount is required' };
  }
  const targetNumber = Number(raw.targetAmount);
  if (!Number.isFinite(targetNumber) || targetNumber <= 0) {
    return {
      ok: false,
      status: 400,
      error: 'targetAmount must be greater than 0',
    };
  }
  const targetAmount = targetNumber.toFixed(4);

  const currentAmountRaw = raw.currentAmount;
  let currentAmount = '0.0000';
  if (currentAmountRaw != null && currentAmountRaw !== '') {
    const normalized = normalizeAmount(currentAmountRaw, true);
    if (normalized === 'invalid') {
      return {
        ok: false,
        status: 400,
        error: 'currentAmount must be a non-negative number',
      };
    }
    currentAmount = normalized;
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
    const candidate = String(raw.targetDate);
    if (!ISO_DATE_RE.test(candidate)) {
      return {
        ok: false,
        status: 400,
        error: 'targetDate must be YYYY-MM-DD',
      };
    }
    targetDate = candidate;
  }

  let monthlyContribution: string | null = null;
  if (raw.monthlyContribution != null && raw.monthlyContribution !== '') {
    const normalized = normalizeAmount(raw.monthlyContribution, true);
    if (normalized === 'invalid') {
      return {
        ok: false,
        status: 400,
        error: 'monthlyContribution must be a non-negative number',
      };
    }
    monthlyContribution = normalized;
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
  if (raw.priority != null && raw.priority !== '') {
    const n = Number(raw.priority);
    if (!Number.isInteger(n) || n < 0) {
      return {
        ok: false,
        status: 400,
        error: 'priority must be a non-negative integer',
      };
    }
    priority = n;
  }

  let status: FinancialGoalStatus = 'active';
  if (raw.status != null && raw.status !== '') {
    const candidate = String(raw.status);
    if (!(FINANCIAL_GOAL_STATUSES as readonly string[]).includes(candidate)) {
      return {
        ok: false,
        status: 400,
        error: `status must be one of: ${FINANCIAL_GOAL_STATUSES.join(', ')}`,
      };
    }
    status = candidate as FinancialGoalStatus;
  }

  const notes = normalizeOptionalString(raw.notes, MAX_NOTES_LENGTH);

  return {
    ok: true,
    value: {
      name,
      targetAmount,
      currentAmount,
      currency: currencyRaw,
      targetDate,
      monthlyContribution,
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
export function validateGoalPatch(
  raw: Record<string, unknown>,
): ValidationResult<NormalizedGoalPatch> {
  const out: NormalizedGoalPatch = {};

  if (raw.name !== undefined) {
    const name = normalizeOptionalString(raw.name, MAX_NAME_LENGTH);
    if (!name) return { ok: false, status: 400, error: 'name cannot be empty' };
    out.name = name;
  }

  if (raw.targetAmount !== undefined) {
    const n = Number(raw.targetAmount);
    if (!Number.isFinite(n) || n <= 0) {
      return {
        ok: false,
        status: 400,
        error: 'targetAmount must be greater than 0',
      };
    }
    out.targetAmount = n.toFixed(4);
  }

  if (raw.currentAmount !== undefined) {
    const normalized = normalizeAmount(raw.currentAmount, true);
    if (normalized === 'invalid') {
      return {
        ok: false,
        status: 400,
        error: 'currentAmount must be a non-negative number',
      };
    }
    out.currentAmount = normalized;
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
      const candidate = String(raw.targetDate);
      if (!ISO_DATE_RE.test(candidate)) {
        return {
          ok: false,
          status: 400,
          error: 'targetDate must be YYYY-MM-DD',
        };
      }
      out.targetDate = candidate;
    }
  }

  if (raw.monthlyContribution !== undefined) {
    if (raw.monthlyContribution === null || raw.monthlyContribution === '') {
      out.monthlyContribution = null;
    } else {
      const normalized = normalizeAmount(raw.monthlyContribution, true);
      if (normalized === 'invalid') {
        return {
          ok: false,
          status: 400,
          error: 'monthlyContribution must be a non-negative number',
        };
      }
      out.monthlyContribution = normalized;
    }
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
    const n = Number(raw.priority);
    if (!Number.isInteger(n) || n < 0) {
      return {
        ok: false,
        status: 400,
        error: 'priority must be a non-negative integer',
      };
    }
    out.priority = n;
  }

  if (raw.status !== undefined) {
    const candidate = String(raw.status);
    if (!(FINANCIAL_GOAL_STATUSES as readonly string[]).includes(candidate)) {
      return {
        ok: false,
        status: 400,
        error: `status must be one of: ${FINANCIAL_GOAL_STATUSES.join(', ')}`,
      };
    }
    out.status = candidate as FinancialGoalStatus;
  }

  if (raw.notes !== undefined) {
    out.notes = normalizeOptionalString(raw.notes, MAX_NOTES_LENGTH);
  }

  return { ok: true, value: out };
}

type GoalResponse = {
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
  createdAt: string;
  updatedAt: string;
};

function serializeGoal(row: InstanceType<typeof FinancialGoal>): GoalResponse {
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToSnapshot(row: InstanceType<typeof FinancialGoal>): GoalSnapshot {
  const createdAtIso = row.createdAt.toISOString().slice(0, 10);
  return {
    id: row.id,
    name: row.name,
    targetAmount: String(row.targetAmount),
    currentAmount: String(row.currentAmount),
    currency: row.currency,
    targetDate: row.targetDate,
    monthlyContribution:
      row.monthlyContribution == null ? null : String(row.monthlyContribution),
    status: row.status,
    createdAt: createdAtIso,
  };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Verify an account (if supplied) belongs to the caller's household. Returns
 * a string error if the check fails, or null on success / null id.
 */
async function checkAccountInHousehold(
  accountId: number | null,
  householdId: number,
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
    if (req.query.currency) {
      where.currency = String(req.query.currency).toUpperCase().slice(0, 3);
    }

    const rows = await FinancialGoal.findAll({
      where,
      // Highest priority first, then earliest target date, then newest.
      order: [
        ['priority', 'DESC'],
        ['targetDate', 'ASC'],
        ['createdAt', 'ASC'],
      ],
    });

    res.json({ data: rows.map(serializeGoal) });
  } catch (e) {
    next(e);
  }
});

/**
 * Aggregate required monthly contributions across the household's *active*
 * goals, grouped by currency. Used by safe-to-spend (issue #199) when it
 * lands. Mounted at GET /api/goals/summary/required-contributions to keep
 * the URL above the /:id catch-all.
 */
router.get('/summary/required-contributions', async (req, res, next) => {
  try {
    const rows = await FinancialGoal.findAll({
      where: { ...householdWhere(req), status: 'active' },
    });
    const snapshots = rows.map(rowToSnapshot);
    const byCurrency = requiredMonthlyContributionsByCurrency(
      snapshots,
      todayIso(),
    );
    res.json({ today: todayIso(), byCurrency });
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
    res.json(serializeGoal(row));
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
    const projection = projectGoal(rowToSnapshot(row), todayIso());
    res.json(projection);
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = validateGoalInput(body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const accountErr = await checkAccountInHousehold(
      result.value.linkedAccountId,
      household.id,
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

    res.status(201).json(serializeGoal(row));
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
    const result = validateGoalPatch(body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    const patch = result.value;

    if (patch.linkedAccountId !== undefined) {
      const accountErr = await checkAccountInHousehold(
        patch.linkedAccountId,
        row.householdId,
      );
      if (accountErr) {
        res.status(400).json({ error: accountErr });
        return;
      }
    }

    if (patch.name !== undefined) row.set('name', patch.name);
    if (patch.targetAmount !== undefined) row.set('targetAmount', patch.targetAmount);
    if (patch.currentAmount !== undefined) row.set('currentAmount', patch.currentAmount);
    if (patch.currency !== undefined) row.set('currency', patch.currency);
    if (patch.targetDate !== undefined) row.set('targetDate', patch.targetDate);
    if (patch.monthlyContribution !== undefined) {
      row.set('monthlyContribution', patch.monthlyContribution);
    }
    if (patch.linkedAccountId !== undefined) {
      row.set('linkedAccountId', patch.linkedAccountId);
    }
    if (patch.priority !== undefined) row.set('priority', patch.priority);
    if (patch.status !== undefined) row.set('status', patch.status);
    if (patch.notes !== undefined) row.set('notes', patch.notes);

    await row.save();
    res.json(serializeGoal(row));
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
