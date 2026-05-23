import { Router } from 'express';
import { Op } from 'sequelize';
import {
  BudgetTarget,
  BUDGET_TARGET_PERIODS,
  type BudgetTargetPeriod,
} from '../models/BudgetTarget';
import { Transaction } from '../models';
import { num } from '../util/numbers';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';

const router = Router();

type NormalizedBudgetInput = {
  category: string | null;
  currency: string;
  amount: string;
  period: BudgetTargetPeriod;
};

type ValidationResult =
  | { ok: true; value: NormalizedBudgetInput }
  | { ok: false; status: number; error: string };

type NormalizedBudgetPatch = Partial<NormalizedBudgetInput>;

type PatchValidationResult =
  | { ok: true; value: NormalizedBudgetPatch }
  | { ok: false; status: number; error: string };

/**
 * Pure validator for POST /api/budgets bodies. Exported for unit tests so we
 * can exercise validation rules without spinning up the database.
 *
 * Treats `null` / `''` category as "overall" — the budget covers total spend
 * across all categories in the matching currency. Amount must be a finite,
 * positive number; currency must be a 3-letter ISO code; period defaults to
 * `monthly` (extension hook for future weekly/yearly buckets).
 */
export function validateBudgetInput(
  raw: Record<string, unknown>
): ValidationResult {
  const categoryNorm = normalizeCategory(raw.category);

  const currencyRaw = String(raw.currency ?? '').trim().toUpperCase();
  if (currencyRaw.length !== 3) {
    return {
      ok: false,
      status: 400,
      error: 'currency must be a 3-letter ISO code',
    };
  }

  const amountNumber = Number(raw.amount);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
    return {
      ok: false,
      status: 400,
      error: 'amount must be a positive number',
    };
  }

  let period: BudgetTargetPeriod = 'monthly';
  if (raw.period != null && raw.period !== '') {
    const candidate = String(raw.period);
    if (!(BUDGET_TARGET_PERIODS as readonly string[]).includes(candidate)) {
      return {
        ok: false,
        status: 400,
        error: `period must be one of: ${BUDGET_TARGET_PERIODS.join(', ')}`,
      };
    }
    period = candidate as BudgetTargetPeriod;
  }

  return {
    ok: true,
    value: {
      category: categoryNorm,
      currency: currencyRaw,
      amount: amountNumber.toFixed(4),
      period,
    },
  };
}

/**
 * Pure validator for PUT /api/budgets/:id bodies. Each field is optional;
 * unknown fields are ignored. Returns a partial input that callers can apply
 * via `row.set(...)`. The same rules as POST apply to any field that IS
 * supplied (positive amount, 3-letter currency, known period).
 */
export function validateBudgetPatch(
  raw: Record<string, unknown>
): PatchValidationResult {
  const out: NormalizedBudgetPatch = {};

  if (raw.category !== undefined) {
    out.category = normalizeCategory(raw.category);
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

  if (raw.amount !== undefined) {
    const amountNumber = Number(raw.amount);
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      return {
        ok: false,
        status: 400,
        error: 'amount must be a positive number',
      };
    }
    out.amount = amountNumber.toFixed(4);
  }

  if (raw.period !== undefined) {
    const candidate = String(raw.period);
    if (!(BUDGET_TARGET_PERIODS as readonly string[]).includes(candidate)) {
      return {
        ok: false,
        status: 400,
        error: `period must be one of: ${BUDGET_TARGET_PERIODS.join(', ')}`,
      };
    }
    out.period = candidate as BudgetTargetPeriod;
  }

  return { ok: true, value: out };
}

function normalizeCategory(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.slice(0, 128);
}

type BudgetResponse = {
  id: number;
  householdId: number;
  category: string | null;
  currency: string;
  amount: string;
  period: BudgetTargetPeriod;
  createdAt: string;
  updatedAt: string;
};

function serializeBudget(row: InstanceType<typeof BudgetTarget>): BudgetResponse {
  return {
    id: row.id,
    householdId: row.householdId,
    category: row.category,
    currency: row.currency,
    amount: String(row.amount),
    period: row.period,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get('/', async (req, res, next) => {
  try {
    const where: Record<string, unknown> = { ...householdWhere(req) };
    if (req.query.currency) {
      where.currency = String(req.query.currency).toUpperCase().slice(0, 3);
    }
    const rows = await BudgetTarget.findAll({
      where,
      order: [
        ['currency', 'ASC'],
        ['category', 'ASC'],
        ['createdAt', 'ASC'],
      ],
    });
    res.json({ data: rows.map(serializeBudget) });
  } catch (e) {
    next(e);
  }
});

/**
 * Returns the inclusive [start, end] ISO date strings for the calendar month
 * containing `now`, in the local timezone. We deliberately use local time so
 * "this month" matches what a user sees on their phone calendar; date storage
 * on Transaction.date is DATEONLY (no TZ), and the dashboard date filter
 * already operates in local terms.
 */
export function currentMonthBounds(
  now: Date = new Date()
): { periodStart: string; periodEnd: string } {
  const y = now.getFullYear();
  const m = now.getMonth();
  const startDate = new Date(y, m, 1);
  const endDate = new Date(y, m + 1, 0);
  const fmt = (d: Date): string => {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };
  return { periodStart: fmt(startDate), periodEnd: fmt(endDate) };
}

type SpendRow = { currency: string; finalCategory: string | null; amount: unknown };

/**
 * Aggregate raw transaction rows into spend per (currency, category).
 *
 * Spend semantics: charges land in the DB as NEGATIVE numbers, so we sum the
 * negation (`-amount`) and only count `amount < 0`. Positive amounts (refunds,
 * credits, payments, transfers) are intentionally ignored here — they offset
 * spend elsewhere but a budget tracks gross outflow against a target. The
 * dashboard's category report already nets credits separately if desired.
 *
 * Pure helper exported so the route's correctness can be tested without a DB.
 */
export function aggregateSpendByCategory(
  rows: SpendRow[]
): Map<string, { currency: string; category: string | null; spent: number }> {
  const out = new Map<
    string,
    { currency: string; category: string | null; spent: number }
  >();
  for (const row of rows) {
    const amount = num(row.amount);
    if (amount == null || amount >= 0) continue;
    const spend = -amount;
    const key = `${row.currency}\0${row.finalCategory ?? ''}`;
    const existing = out.get(key) ?? {
      currency: row.currency,
      category: row.finalCategory,
      spent: 0,
    };
    existing.spent += spend;
    out.set(key, existing);
  }
  return out;
}

type BudgetForProgress = {
  id: number;
  category: string | null;
  currency: string;
  amount: string;
};

type ProgressItem = {
  budgetId: number;
  category: string | null;
  currency: string;
  target: number;
  spent: number;
  remaining: number;
  percentUsed: number;
  periodStart: string;
  periodEnd: string;
};

/**
 * Combine budget rows with the spend aggregate. Pure so we can unit-test the
 * "overall" vs per-category split without a DB.
 *
 * Overall semantics: a budget with `category == null` sums spend across every
 * category that shares its currency. Per-category budgets look up just their
 * own (currency, category) key.
 */
export function computeBudgetProgress(
  budgets: BudgetForProgress[],
  spendByCategory: Map<
    string,
    { currency: string; category: string | null; spent: number }
  >,
  bounds: { periodStart: string; periodEnd: string }
): ProgressItem[] {
  const totalsByCurrency = new Map<string, number>();
  for (const value of spendByCategory.values()) {
    totalsByCurrency.set(
      value.currency,
      (totalsByCurrency.get(value.currency) ?? 0) + value.spent
    );
  }
  return budgets.map((budget) => {
    const target = Number(budget.amount);
    let spent: number;
    if (budget.category == null) {
      spent = totalsByCurrency.get(budget.currency) ?? 0;
    } else {
      const key = `${budget.currency}\0${budget.category}`;
      spent = spendByCategory.get(key)?.spent ?? 0;
    }
    const remaining = target - spent;
    const percentUsed = target > 0 ? (spent / target) * 100 : 0;
    return {
      budgetId: budget.id,
      category: budget.category,
      currency: budget.currency,
      target,
      spent,
      remaining,
      percentUsed,
      periodStart: bounds.periodStart,
      periodEnd: bounds.periodEnd,
    };
  });
}

router.get('/progress', async (req, res, next) => {
  try {
    const bounds = currentMonthBounds();
    const where: Record<string, unknown> = { ...householdWhere(req) };
    if (req.query.currency) {
      where.currency = String(req.query.currency).toUpperCase().slice(0, 3);
    }

    const budgets = await BudgetTarget.findAll({
      where,
      order: [
        ['currency', 'ASC'],
        ['category', 'ASC'],
        ['createdAt', 'ASC'],
      ],
    });

    const currencies = Array.from(new Set(budgets.map((b) => b.currency)));
    const txWhere: Record<string, unknown> = {
      ...householdWhere(req),
      date: {
        [Op.gte]: bounds.periodStart,
        [Op.lte]: bounds.periodEnd,
      },
    };
    if (currencies.length > 0) {
      txWhere.currency = { [Op.in]: currencies };
    }
    const rows =
      budgets.length === 0
        ? []
        : await Transaction.findAll({
            where: txWhere,
            attributes: ['currency', 'finalCategory', 'amount'],
            raw: true,
          });

    const spendByCategory = aggregateSpendByCategory(
      rows as unknown as SpendRow[]
    );
    const items = computeBudgetProgress(
      budgets.map((b) => ({
        id: b.id,
        category: b.category,
        currency: b.currency,
        amount: String(b.amount),
      })),
      spendByCategory,
      bounds
    );

    res.json({ items });
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = validateBudgetInput(body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    const { household } = currentAuth(req);
    const row = await BudgetTarget.create({
      householdId: household.id,
      category: result.value.category,
      currency: result.value.currency,
      amount: result.value.amount,
      period: result.value.period,
    });
    res.status(201).json(serializeBudget(row));
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
    const row = await BudgetTarget.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = validateBudgetPatch(body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    const patch = result.value;
    if (patch.category !== undefined) row.set('category', patch.category);
    if (patch.currency !== undefined) row.set('currency', patch.currency);
    if (patch.amount !== undefined) row.set('amount', patch.amount);
    if (patch.period !== undefined) row.set('period', patch.period);
    await row.save();
    res.json(serializeBudget(row));
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
    const row = await BudgetTarget.findOne({
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
