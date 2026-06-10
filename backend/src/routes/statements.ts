/**
 * Statement reconciliation endpoints (issue #242).
 *
 * Lets a user create or import a statement period for an account, then
 * compares the statement's reported closing balance against the sum of
 * transactions in that period. The variance and reconciliation status
 * surface in the detail response; the user can attach an explanation and
 * mark the statement reconciled when they're satisfied.
 *
 *   POST   /api/statements                 — create a statement
 *   GET    /api/statements                 — list (filterable by accountId)
 *   GET    /api/statements/:id             — detail + computed variance + txns
 *   PATCH  /api/statements/:id             — update editable fields
 *   POST   /api/statements/:id/reconcile   — mark reconciled
 *   POST   /api/statements/:id/unreconcile — clear reconciliation
 *   DELETE /api/statements/:id             — remove
 *
 * Authorization: every endpoint scopes to the caller's household via
 * {@link visibleWhere} (statements) and {@link visibleAccountWhere}
 * (the parent account). Cross-household statements return 404, never 403,
 * so the existence of another household's data is never disclosed.
 *
 * The reconciliation math (expectedClosing / variance) lives in the pure
 * helper {@link computeReconciliation}; the route only handles I/O and
 * scope.
 */
import { Router } from 'express';
import { Op } from 'sequelize';
import {
  Account,
  AccountStatement,
  Transaction,
  sequelize,
} from '../models';
import {
  householdWhere,
  visibleAccountWhere,
  visibleStatementWhere,
} from '../auth/scope';
import { accountKind } from '../networth/accountKind';
import { currentAuth } from '../auth/middleware';
import { logger } from '../observability/logger';
import { aiSuggestLimiter } from './aiRateLimit';
import {
  computeReconciliation,
  isBalanced,
} from '../statements/computeReconciliation';

const router = Router();

// Statement endpoints touch the database on every call. Add the shared
// AI-tier rate limiter to defend against burst writes / abuse. The limiter
// no-ops under NODE_ENV=test, so the integration suite is unaffected.
router.use(aiSuggestLimiter);

function asNumberId(raw: unknown): number | null {
  const n = parseInt(String(raw), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isIsoDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function asDecimalString(v: unknown): string | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(4);
}

/**
 * Serialize an AccountStatement row into the camelCase JSON shape used by
 * the frontend. Drops Sequelize snake_case duplicates and parses DECIMAL
 * fields back to numbers for consumer ergonomics.
 */
type AccountWithMeta = {
  id: number;
  name: string;
  shortCode: string | null;
  defaultCurrency: string | null;
};

function serializeStatement(
  row: AccountStatement & { account?: AccountWithMeta | null },
): Record<string, unknown> {
  const o = row.toJSON() as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (k.includes('_')) delete o[k];
  }
  for (const k of ['openingBalance', 'closingBalance']) {
    if (o[k] != null) o[k] = Number(o[k]);
  }
  return o;
}

/**
 * Load a statement + its account in one shot, scoped to the caller's
 * household. Returns null when the row doesn't exist or is not visible.
 */
async function loadVisibleStatement(
  req: import('express').Request,
  id: number,
): Promise<(AccountStatement & { account?: AccountWithMeta | null }) | null> {
  const row = await AccountStatement.findOne({
    where: { id, ...visibleStatementWhere(req) },
    include: [
      {
        model: Account,
        as: 'account',
        attributes: ['id', 'name', 'shortCode', 'defaultCurrency'],
      },
    ],
  });
  return row as
    | (AccountStatement & { account?: AccountWithMeta | null })
    | null;
}

/**
 * POST /api/statements
 *
 * Body: `{ accountId, periodStart, periodEnd, openingBalance,
 *          closingBalance, currency?, sourceFilename?, notes?,
 *          visibility? }`
 *
 * Returns 201 with the serialized row. Refuses with:
 *   - 400 if any required field is missing or malformed.
 *   - 400 if periodEnd < periodStart.
 *   - 404 if accountId is not visible to the caller.
 *   - 409 if (accountId, periodStart, periodEnd) already exists.
 */
router.post('/', async (req, res, next) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const accountId = asNumberId(body.accountId);
    if (accountId == null) {
      res.status(400).json({ error: 'accountId must be a positive integer' });
      return;
    }
    if (!isIsoDate(body.periodStart)) {
      res
        .status(400)
        .json({ error: 'periodStart must be an ISO date (YYYY-MM-DD)' });
      return;
    }
    if (!isIsoDate(body.periodEnd)) {
      res
        .status(400)
        .json({ error: 'periodEnd must be an ISO date (YYYY-MM-DD)' });
      return;
    }
    if (body.periodEnd < body.periodStart) {
      res.status(400).json({ error: 'periodEnd must be on or after periodStart' });
      return;
    }
    const openingBalance = asDecimalString(body.openingBalance);
    if (openingBalance == null) {
      res.status(400).json({ error: 'openingBalance must be a finite number' });
      return;
    }
    const closingBalance = asDecimalString(body.closingBalance);
    if (closingBalance == null) {
      res.status(400).json({ error: 'closingBalance must be a finite number' });
      return;
    }

    const account = await Account.findOne({
      where: { id: accountId, ...visibleAccountWhere(req) },
    });
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    const auth = currentAuth(req);
    const visibility =
      body.visibility === 'private' || body.visibility === 'shared'
        ? (body.visibility as string)
        : 'shared';
    const currency =
      typeof body.currency === 'string' && /^[A-Za-z]{3}$/.test(body.currency)
        ? body.currency.toUpperCase()
        : (account.defaultCurrency ?? 'CAD');
    const sourceFilename =
      typeof body.sourceFilename === 'string' && body.sourceFilename.length > 0
        ? body.sourceFilename.slice(0, 512)
        : null;
    const notes = typeof body.notes === 'string' ? body.notes : null;

    let row: AccountStatement;
    try {
      row = await AccountStatement.create({
        householdId: auth.household.id,
        accountId,
        createdByUserId: auth.user.id,
        visibility,
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
        openingBalance,
        closingBalance,
        currency,
        sourceFilename,
        notes,
        reconciledAt: null,
        varianceExplanation: null,
      });
    } catch (e) {
      // UNIQUE (account_id, period_start, period_end) collision → 409.
      const msg = e instanceof Error ? e.message : String(e);
      if (
        /SequelizeUniqueConstraintError|UNIQUE constraint|duplicate key/i.test(
          msg,
        ) ||
        (e as { name?: string }).name === 'SequelizeUniqueConstraintError'
      ) {
        res.status(409).json({
          error:
            'A statement already exists for this account and period; edit the existing one instead.',
        });
        return;
      }
      throw e;
    }

    await row.reload({
      include: [
        {
          model: Account,
          as: 'account',
          attributes: ['id', 'name', 'shortCode', 'defaultCurrency'],
        },
      ],
    });
    logger.info(
      {
        statementId: row.id,
        accountId,
        householdId: auth.household.id,
        userId: auth.user.id,
      },
      'statement_created',
    );
    res.status(201).json({
      data: serializeStatement(
        row as AccountStatement & { account?: AccountWithMeta | null },
      ),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/statements
 *
 * Query params:
 *   - accountId (optional)         filter to one account
 *   - status (optional)            'reconciled' | 'unreconciled'
 *   - page (1-based, default 1)
 *   - pageSize (default 50, max 100)
 *
 * Each row includes the parent Account's id/name/shortCode so the UI
 * can render statement→account without an extra fetch.
 */
router.get('/', async (req, res, next) => {
  try {
    // parseInt('abc') is NaN and Math.max(1, NaN) is NaN — guard with a
    // finite check so malformed params fall back to the defaults instead
    // of feeding NaN limit/offset into Sequelize.
    const rawPage = parseInt(String(req.query.page ?? '1'), 10);
    const page = Math.max(1, Number.isInteger(rawPage) ? rawPage : 1);
    const rawPageSize = parseInt(String(req.query.pageSize ?? '50'), 10);
    const pageSize = Math.min(
      100,
      Math.max(1, Number.isInteger(rawPageSize) ? rawPageSize : 50),
    );
    const offset = (page - 1) * pageSize;
    const where: Record<string, unknown> = { ...visibleStatementWhere(req) };
    if (req.query.accountId) {
      const aid = asNumberId(req.query.accountId);
      if (aid != null) where.accountId = aid;
    }
    if (req.query.status === 'reconciled') {
      where.reconciledAt = { [Op.ne]: null };
    } else if (req.query.status === 'unreconciled') {
      where.reconciledAt = null;
    }
    const { rows, count } = await AccountStatement.findAndCountAll({
      where,
      include: [
        {
          model: Account,
          as: 'account',
          attributes: ['id', 'name', 'shortCode', 'defaultCurrency'],
        },
      ],
      order: [
        ['periodEnd', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: pageSize,
      offset,
    });
    res.json({
      data: (rows as Array<AccountStatement & { account?: AccountWithMeta | null }>).map(
        (r) => serializeStatement(r),
      ),
      page,
      pageSize,
      total: count,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * Gather the account's posted, statement-currency transactions inside the
 * statement's window and feed them to {@link computeReconciliation}.
 * Liability accounts are compared in the bank's positive-owed convention.
 */
async function getReconciliationFor(
  statement: AccountStatement,
  req: import('express').Request,
) {
  const txns = await Transaction.findAll({
    where: {
      // Reconciliation is an account-level ledger check against the bank's
      // numbers: every household row on the account is real money in the
      // bank's closing balance, so scope by household only — NOT by the
      // viewer's per-transaction visibility (otherwise the same statement
      // reports different math to each spouse). The statement itself is
      // still visibility-scoped by the caller via loadVisibleStatement.
      ...householdWhere(req),
      accountId: statement.accountId,
      // A bank statement reflects posted activity only — pending rows are
      // not part of the reported closing balance.
      status: { [Op.ne]: 'pending' },
      // Multi-currency accounts: only rows in the statement's currency
      // explain its balances (mirrors networth/balanceAtDate's
      // per-currency bucketing).
      currency: statement.currency,
      date: { [Op.between]: [statement.periodStart, statement.periodEnd] },
    },
    attributes: [
      'id',
      'date',
      'amount',
      'currency',
      'merchantClean',
      'merchantRaw',
      'finalCategory',
      'txnType',
      'linkedTransactionId',
      'transferPurpose',
      'status',
    ],
    order: [
      ['date', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  // Liability statements (credit card / loan / mortgage) print balances as
  // positive amounts owed, while charges are stored negative internally
  // (csvProfiles invert_sign). Negate the transaction stream so
  // expectedClosing stays in the bank's positive-owed convention the user
  // transcribed from the statement.
  const account = await Account.findByPk(statement.accountId, {
    attributes: ['id', 'accountType'],
  });
  const isLiability =
    account != null && accountKind(account.accountType) === 'liability';
  const result = computeReconciliation({
    openingBalance: statement.openingBalance,
    closingBalance: statement.closingBalance,
    transactions: txns.map((t) => ({
      amount: isLiability ? -Number(t.amount) : t.amount,
    })),
  });
  return {
    reconciliation: {
      ...result,
      isBalanced: isBalanced(result),
    },
    transactions: txns.map((t) => ({
      id: t.id,
      date: t.date,
      amount: Number(t.amount),
      currency: t.currency,
      merchantClean: t.merchantClean,
      merchantRaw: t.merchantRaw,
      finalCategory: t.finalCategory,
      txnType: t.txnType,
      linkedTransactionId: t.linkedTransactionId,
      transferPurpose: t.transferPurpose,
      status: t.status,
    })),
  };
}

/**
 * GET /api/statements/:id
 *
 * Detail view with reconciliation math AND the transactions that fall
 * inside the statement's window (so the UI can render "inspect period").
 */
router.get('/:id', async (req, res, next) => {
  try {
    const id = asNumberId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await loadVisibleStatement(req, id);
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const { reconciliation, transactions } = await getReconciliationFor(row, req);
    res.json({
      data: serializeStatement(row),
      reconciliation,
      transactions,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /api/statements/:id
 *
 * Editable fields (all optional):
 *   openingBalance, closingBalance, notes, sourceFilename,
 *   varianceExplanation, visibility, currency.
 *
 * periodStart/periodEnd/accountId are NOT editable — deleting the row
 * and creating a new one is the supported flow for that level of change
 * (avoids invalidating the reconciliation in subtle ways).
 */
router.patch('/:id', async (req, res, next) => {
  try {
    const id = asNumberId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await loadVisibleStatement(req, id);
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    if ('openingBalance' in body) {
      const v = asDecimalString(body.openingBalance);
      if (v == null) {
        res
          .status(400)
          .json({ error: 'openingBalance must be a finite number' });
        return;
      }
      row.openingBalance = v;
    }
    if ('closingBalance' in body) {
      const v = asDecimalString(body.closingBalance);
      if (v == null) {
        res
          .status(400)
          .json({ error: 'closingBalance must be a finite number' });
        return;
      }
      row.closingBalance = v;
    }
    if ('notes' in body) {
      row.notes =
        typeof body.notes === 'string' ? body.notes : body.notes == null ? null : null;
    }
    if ('sourceFilename' in body) {
      row.sourceFilename =
        typeof body.sourceFilename === 'string'
          ? body.sourceFilename.slice(0, 512)
          : null;
    }
    if ('varianceExplanation' in body) {
      row.varianceExplanation =
        typeof body.varianceExplanation === 'string'
          ? body.varianceExplanation
          : body.varianceExplanation == null
            ? null
            : null;
    }
    if ('visibility' in body) {
      if (body.visibility !== 'private' && body.visibility !== 'shared') {
        res
          .status(400)
          .json({ error: "visibility must be 'private' or 'shared'" });
        return;
      }
      row.visibility = body.visibility as string;
    }
    if ('currency' in body) {
      if (
        typeof body.currency !== 'string' ||
        !/^[A-Za-z]{3}$/.test(body.currency)
      ) {
        res.status(400).json({ error: 'currency must be a 3-letter code' });
        return;
      }
      row.currency = body.currency.toUpperCase();
    }
    await row.save();
    await row.reload({
      include: [
        {
          model: Account,
          as: 'account',
          attributes: ['id', 'name', 'shortCode', 'defaultCurrency'],
        },
      ],
    });
    const { reconciliation, transactions } = await getReconciliationFor(row, req);
    res.json({
      data: serializeStatement(row),
      reconciliation,
      transactions,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/statements/:id/reconcile
 *
 * Marks the statement reconciled. Refuses with 400 when variance is
 * non-zero AND no `varianceExplanation` has been recorded — the user must
 * explain the difference before accepting it.
 *
 * Body (optional): `{ varianceExplanation?: string }` — if provided,
 * stored alongside the reconciledAt timestamp in one shot. Convenience for
 * the UI so the user can reconcile + explain in a single round-trip.
 */
router.post('/:id/reconcile', async (req, res, next) => {
  try {
    const id = asNumberId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await loadVisibleStatement(req, id);
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    let explanationFromBody: string | null = null;
    if ('varianceExplanation' in body) {
      explanationFromBody =
        typeof body.varianceExplanation === 'string'
          ? body.varianceExplanation
          : null;
    }
    const { reconciliation } = await getReconciliationFor(row, req);
    const balanced = isBalanced(reconciliation);
    const explanation =
      explanationFromBody != null && explanationFromBody.trim().length > 0
        ? explanationFromBody
        : row.varianceExplanation;
    if (!balanced && (explanation == null || explanation.trim().length === 0)) {
      res.status(400).json({
        error:
          'Statement has a variance — record a varianceExplanation before reconciling.',
        variance: reconciliation.variance,
      });
      return;
    }
    await sequelize.transaction(async (t) => {
      row.reconciledAt = new Date();
      if (explanationFromBody != null) {
        row.varianceExplanation = explanationFromBody;
      }
      await row.save({ transaction: t });
    });
    await row.reload({
      include: [
        {
          model: Account,
          as: 'account',
          attributes: ['id', 'name', 'shortCode', 'defaultCurrency'],
        },
      ],
    });
    const { reconciliation: r2, transactions } = await getReconciliationFor(
      row,
      req,
    );
    logger.info(
      {
        statementId: row.id,
        accountId: row.accountId,
        householdId: row.householdId,
        variance: r2.variance,
      },
      'statement_reconciled',
    );
    res.json({
      data: serializeStatement(row),
      reconciliation: r2,
      transactions,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/statements/:id/unreconcile
 *
 * Clears `reconciledAt` so the user can revisit the statement. The
 * variance explanation is preserved (useful audit trail) — the user can
 * clear it explicitly via PATCH if desired.
 */
router.post('/:id/unreconcile', async (req, res, next) => {
  try {
    const id = asNumberId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await loadVisibleStatement(req, id);
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (row.reconciledAt == null) {
      res.status(400).json({ error: 'Statement is not currently reconciled' });
      return;
    }
    row.reconciledAt = null;
    await row.save();
    await row.reload({
      include: [
        {
          model: Account,
          as: 'account',
          attributes: ['id', 'name', 'shortCode', 'defaultCurrency'],
        },
      ],
    });
    const { reconciliation, transactions } = await getReconciliationFor(row, req);
    res.json({
      data: serializeStatement(row),
      reconciliation,
      transactions,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /api/statements/:id
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const id = asNumberId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await loadVisibleStatement(req, id);
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    await row.destroy();
    logger.info(
      {
        statementId: id,
        accountId: row.accountId,
        householdId: row.householdId,
      },
      'statement_deleted',
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
