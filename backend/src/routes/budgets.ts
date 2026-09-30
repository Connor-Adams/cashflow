import { Router } from 'express';
import { OptimisticLockError } from 'sequelize';
import {
  BudgetTarget,
  BUDGET_TARGET_PERIODS,
  BUDGET_TARGET_SCOPES,
  BUDGET_TARGET_DEFAULT_ALERT_THRESHOLDS,
  type BudgetTargetPeriod,
  type BudgetTargetScope,
} from '../models/BudgetTarget';
import { BudgetExclusion, Transaction } from '../models';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';
import {
  loadBudgetStatuses,
  toBudgetSpendInput,
  type BudgetStatusItem,
} from '../budgets/budgetSpend';

/**
 * The budget domain math used to live in this file; it now lives under
 * `budgets/` so the route layer, the shared spend pipeline and the breach cron
 * form a one-way dependency instead of a cycle. These re-exports keep every
 * existing importer — `routes/reports.ts`, the colocated unit tests — working
 * against the original paths.
 */
export {
  currentMonthBounds,
  currentWeekBounds,
  currentYearBounds,
  currentPeriodBounds,
  previousPeriodBounds,
  periodElapsedPercent,
  pacingState,
  periodKey,
  type BudgetPacingState,
} from '../budgets/budgetPeriods';
export {
  aggregateSpendByCategory,
  categoryAndDescendantNames,
  computeBudgetProgress,
  netRefundsFromSpend,
  resolveRefundNets,
  scopeWhereClause,
  type RefundNet,
} from '../budgets/budgetSpendMath';

const router = Router();

type NormalizedBudgetInput = {
  category: string | null;
  currency: string;
  amount: string;
  period: BudgetTargetPeriod;
  scope: BudgetTargetScope;
  rolloverEnabled: boolean;
  excludeRefundedPurchases: boolean;
  alertThresholds: number[];
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
 * `monthly` (now extended to also accept weekly/annual); scope defaults to
 * `household`; rolloverEnabled is a boolean and defaults to false.
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

  let scope: BudgetTargetScope = 'household';
  if (raw.scope != null && raw.scope !== '') {
    const candidate = String(raw.scope);
    if (!(BUDGET_TARGET_SCOPES as readonly string[]).includes(candidate)) {
      return {
        ok: false,
        status: 400,
        error: `scope must be one of: ${BUDGET_TARGET_SCOPES.join(', ')}`,
      };
    }
    scope = candidate as BudgetTargetScope;
  }

  const rolloverEnabled = parseBooleanFlag(raw.rolloverEnabled);
  const excludeRefundedPurchases = parseBooleanFlag(raw.excludeRefundedPurchases);

  const thresholdsResult = validateAlertThresholds(raw.alertThresholds);
  if (!thresholdsResult.ok) {
    return thresholdsResult;
  }
  const alertThresholds = thresholdsResult.value;

  return {
    ok: true,
    value: {
      category: categoryNorm,
      currency: currencyRaw,
      amount: amountNumber.toFixed(4),
      period,
      scope,
      rolloverEnabled,
      excludeRefundedPurchases,
      alertThresholds,
    },
  };
}

/**
 * Pure validator for `alertThresholds` (issue #268). Accepts:
 *   - undefined → return defaults [80, 100, 120]
 *   - array of integers in 1..500 → return deduped + sorted ascending
 *   - anything else → 400
 *
 * Dedup + sort here so the model + cron both see the same shape regardless
 * of input ordering, and the column doesn't bloat with `[80, 80, 80]`.
 */
export function validateAlertThresholds(
  raw: unknown,
):
  | { ok: true; value: number[] }
  | { ok: false; status: number; error: string } {
  if (raw === undefined) {
    return { ok: true, value: [...BUDGET_TARGET_DEFAULT_ALERT_THRESHOLDS] };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      status: 400,
      error: 'alertThresholds must be an array of integers',
    };
  }
  if (raw.length === 0) {
    // Allow explicit empty list to disable alerts for this budget. The cron
    // then has nothing to fire — consistent with a user opting out without
    // touching their Notifications-tab channel preference.
    return { ok: true, value: [] };
  }
  const seen = new Set<number>();
  const out: number[] = [];
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      return {
        ok: false,
        status: 400,
        error: 'alertThresholds entries must be integers between 1 and 500',
      };
    }
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  out.sort((a, b) => a - b);
  return { ok: true, value: out };
}

/**
 * Pure validator for PUT /api/budgets/:id bodies. Each field is optional;
 * unknown fields are ignored. Returns a partial input that callers can apply
 * via `row.set(...)`. The same rules as POST apply to any field that IS
 * supplied (positive amount, 3-letter currency, known period, known scope).
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

  if (raw.scope !== undefined) {
    const candidate = String(raw.scope);
    if (!(BUDGET_TARGET_SCOPES as readonly string[]).includes(candidate)) {
      return {
        ok: false,
        status: 400,
        error: `scope must be one of: ${BUDGET_TARGET_SCOPES.join(', ')}`,
      };
    }
    out.scope = candidate as BudgetTargetScope;
  }

  if (raw.rolloverEnabled !== undefined) {
    out.rolloverEnabled = parseBooleanFlag(raw.rolloverEnabled);
  }

  if (raw.excludeRefundedPurchases !== undefined) {
    out.excludeRefundedPurchases = parseBooleanFlag(raw.excludeRefundedPurchases);
  }

  if (raw.alertThresholds !== undefined) {
    const thresholdsResult = validateAlertThresholds(raw.alertThresholds);
    if (!thresholdsResult.ok) return thresholdsResult;
    out.alertThresholds = thresholdsResult.value;
  }

  return { ok: true, value: out };
}

function normalizeCategory(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.slice(0, 128);
}

/**
 * Coerce a truthy-style input into a strict boolean. Accepts the literal
 * `true`, the strings 'true'/'1'/'yes' (case-insensitive), and numeric 1.
 * Everything else (including undefined/null) becomes false. This matches
 * how form submissions and JSON booleans commonly arrive.
 */
function parseBooleanFlag(raw: unknown): boolean {
  if (raw === true) return true;
  if (raw === false || raw == null) return false;
  if (typeof raw === 'number') return raw === 1;
  const s = String(raw).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

type BudgetResponse = {
  id: number;
  householdId: number;
  category: string | null;
  currency: string;
  amount: string;
  period: BudgetTargetPeriod;
  scope: BudgetTargetScope;
  rolloverEnabled: boolean;
  excludeRefundedPurchases: boolean;
  alertThresholds: number[];
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
    scope: row.scope,
    rolloverEnabled: Boolean(row.rolloverEnabled),
    excludeRefundedPurchases: Boolean(row.excludeRefundedPurchases),
    alertThresholds: normalizeAlertThresholdsForSerialize(row.alertThresholds),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Defensive coercion for the column value at serialize time. Sqlite returns
 * the JSON array as a JS array, but a legacy row that was inserted before
 * the migration's default backfilled could in theory have a string-typed
 * value; we fall back to the bundled defaults so the response never lies.
 */
function normalizeAlertThresholdsForSerialize(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw.map((n) => Number(n)).filter((n) => Number.isFinite(n));
  }
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((n) => Number(n)).filter((n) => Number.isFinite(n));
      }
    } catch {
      // Fall through to defaults.
    }
  }
  return [...BUDGET_TARGET_DEFAULT_ALERT_THRESHOLDS];
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

router.get('/progress', async (req, res, next) => {
  try {
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

    const items = await computeStatusForBudgets(req, budgets);
    res.json({ items });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/budgets/status — issue #201's "status" endpoint. Returns the same
 * shape as /progress (kept identical to avoid splitting the dashboard widget
 * code path) but the canonical name from the issue spec. Adopt this endpoint
 * for new clients; /progress is preserved for back-compat with the existing
 * DashboardPage widget.
 */
router.get('/status', async (req, res, next) => {
  try {
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

    const items = await computeStatusForBudgets(req, budgets);
    res.json({ items });
  } catch (e) {
    next(e);
  }
});

/**
 * Thin adapter over the shared spend pipeline in `budgets/budgetSpend.ts`, which
 * the daily breach cron calls too. No budget math lives here any more — this
 * only maps the request's household scope onto the loader's inputs.
 *
 * `householdWhere(req)` is forwarded rather than reduced to a household id
 * because it returns `{}` for a superadmin, and the loader must preserve that.
 */
async function computeStatusForBudgets(
  req: import('express').Request,
  budgets: InstanceType<typeof BudgetTarget>[]
): Promise<BudgetStatusItem[]> {
  return loadBudgetStatuses({
    budgets: budgets.map(toBudgetSpendInput),
    householdId: currentAuth(req).household.id,
    householdWhere: householdWhere(req),
  });
}

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
      scope: result.value.scope,
      rolloverEnabled: result.value.rolloverEnabled,
      excludeRefundedPurchases: result.value.excludeRefundedPurchases,
      alertThresholds: result.value.alertThresholds,
    });
    res.status(201).json(serializeBudget(row));
  } catch (e) {
    next(e);
  }
});

/**
 * Shared PUT/PATCH handler for a single budget target (issue #848). PUT and
 * PATCH were byte-identical blind read-modify-write handlers; they are now one
 * implementation mounted on both verbs.
 *
 * The lost-update fix is the *targeted* column update: only the columns the
 * caller actually sent are written (`validateBudgetPatch` strips `undefined`
 * fields, so `patch` maps 1:1 to columns). A concurrent `PUT {scope}` therefore
 * no longer clobbers a concurrent `PATCH {amount}` — disjoint edits both land.
 * `version: true` on the model is the secondary guard: any full-instance save
 * still carries `WHERE version = N` and fails loudly on a stale write. When two
 * concurrent disjoint edits race, one save loses the version check and throws
 * `OptimisticLockError`; we reload the now-current row and re-apply only this
 * request's columns, so both edits ultimately persist (bounded retry below).
 */
const MAX_OPTIMISTIC_LOCK_RETRIES = 5;

const updateBudgetTarget: import('express').RequestHandler = async (
  req,
  res,
  next
) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = validateBudgetPatch(body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    const patch = result.value as Parameters<
      InstanceType<typeof BudgetTarget>['update']
    >[0];

    // Retry the read-modify-write on a stale-version conflict: a concurrent edit
    // bumped `version` between our findOne and save. Reloading picks up the other
    // edit's columns; re-applying our disjoint columns lets both land (issue #848).
    for (let attempt = 0; ; attempt += 1) {
      const row = await BudgetTarget.findOne({
        where: { id, ...householdWhere(req) },
      });
      if (!row) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (Object.keys(patch).length === 0) {
        res.json(serializeBudget(row));
        return;
      }
      try {
        await row.update(patch);
        res.json(serializeBudget(row));
        return;
      } catch (err) {
        if (
          err instanceof OptimisticLockError &&
          attempt < MAX_OPTIMISTIC_LOCK_RETRIES
        ) {
          continue;
        }
        throw err;
      }
    }
  } catch (e) {
    next(e);
  }
};

router.put('/:id', updateBudgetTarget);

/**
 * Alias for PUT so consumers that prefer PATCH semantics can use the same
 * partial-patch shape. Identical handling — both verbs share one handler.
 */
router.patch('/:id', updateBudgetTarget);

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

// ---- Exclusions -----------------------------------------------------

/**
 * Verify a budget belongs to the requesting household, returning the row
 * or null for not-found. Centralizes the cross-household 404 protection
 * for all exclusion sub-routes.
 */
async function loadOwnedBudget(
  req: import('express').Request,
  id: number
): Promise<InstanceType<typeof BudgetTarget> | null> {
  return BudgetTarget.findOne({
    where: { id, ...householdWhere(req) },
  });
}

router.get('/:id/exclusions', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const budget = await loadOwnedBudget(req, id);
    if (!budget) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const rows = await BudgetExclusion.findAll({
      where: { budgetId: id },
      order: [['createdAt', 'ASC']],
    });
    res.json({
      data: rows.map((row) => ({
        id: row.id,
        budgetId: row.budgetId,
        transactionId: row.transactionId,
        createdAt: row.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/exclusions', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const budget = await loadOwnedBudget(req, id);
    if (!budget) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const txnId = Number(body.transactionId);
    if (!Number.isInteger(txnId) || txnId < 1) {
      res.status(400).json({ error: 'transactionId must be a positive integer' });
      return;
    }
    // Confirm the transaction is in the same household — otherwise the
    // exclusion would silently apply to someone else's data.
    const txn = await Transaction.findOne({
      where: { id: txnId, ...householdWhere(req) },
      attributes: ['id'],
    });
    if (!txn) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }
    // Idempotent: if it already exists, return the existing row.
    const existing = await BudgetExclusion.findOne({
      where: { budgetId: id, transactionId: txnId },
    });
    if (existing) {
      res.status(200).json({
        id: existing.id,
        budgetId: existing.budgetId,
        transactionId: existing.transactionId,
        createdAt: existing.createdAt.toISOString(),
      });
      return;
    }
    const created = await BudgetExclusion.create({
      budgetId: id,
      transactionId: txnId,
    });
    res.status(201).json({
      id: created.id,
      budgetId: created.budgetId,
      transactionId: created.transactionId,
      createdAt: created.createdAt.toISOString(),
    });
  } catch (e) {
    next(e);
  }
});

router.delete('/:id/exclusions/:transactionId', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const txnId = parseInt(req.params.transactionId, 10);
    if (!Number.isInteger(id) || id < 1 || !Number.isInteger(txnId) || txnId < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const budget = await loadOwnedBudget(req, id);
    if (!budget) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const row = await BudgetExclusion.findOne({
      where: { budgetId: id, transactionId: txnId },
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
