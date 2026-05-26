/**
 * Purchase intelligence routes (issue #218).
 *
 * Endpoints:
 *  - POST   /api/transactions/:id/purchase   — upsert tracked-purchase profile.
 *  - GET    /api/transactions/:id/purchase   — fetch profile (404 if not tracked).
 *  - DELETE /api/transactions/:id/purchase   — untrack (remove profile).
 *  - GET    /api/purchases                   — list tracked purchases (filterable).
 *  - GET    /api/purchases/large-inbox       — large UNMARKED transactions
 *                                              (review-queue card for the
 *                                               dashboard / new feature).
 *
 * All routes are scoped via `visibleTransactionWhere` from `auth/scope.ts`
 * so users only see purchases for transactions they have visibility on, and
 * household ownership is enforced via the denormalised `household_id` column
 * on the purchases table.
 *
 * Mutation endpoints use `aiSuggestLimiter` to satisfy the CodeQL
 * "rate-limit authenticated routes" rule. List GETs are pure DB reads but
 * still benefit from a limiter to bound abusive polling, so we apply it to
 * all endpoints in this router.
 */
import { Router } from 'express';
import { Op, type WhereOptions } from 'sequelize';
import {
  Transaction,
  Purchase,
  Receipt,
  Account,
} from '../models';
import {
  PURCHASE_RECEIPT_STATUSES,
  PURCHASE_WARRANTY_STATUSES,
  type PurchaseReceiptStatus,
  type PurchaseWarrantyStatus,
} from '../models/Purchase';
import { currentAuth } from '../auth/middleware';
import { visibleTransactionWhere } from '../auth/scope';
import { aiSuggestLimiter } from './aiRateLimit';
import { costPerMonth, todayIso } from '../util/costPerMonth';

const router = Router();

// All routes in this router are authenticated DB work — rate-limit per
// CodeQL's recommendation. The limiter no-ops in NODE_ENV=test so the
// integration suite stays deterministic.
router.use(aiSuggestLimiter);

// ----- Filter vocab ------------------------------------------------------

export type PurchaseListFilter = 'all' | 'missing-docs' | 'business' | 'large';
export const PURCHASE_LIST_FILTERS: readonly PurchaseListFilter[] = [
  'all',
  'missing-docs',
  'business',
  'large',
] as const;

export function parsePurchaseFilter(
  raw: unknown,
  fallback: PurchaseListFilter = 'all',
): PurchaseListFilter {
  const s = String(raw ?? '').toLowerCase();
  return (PURCHASE_LIST_FILTERS as readonly string[]).includes(s)
    ? (s as PurchaseListFilter)
    : fallback;
}

/** Default "large" threshold in absolute units of currency. */
export const LARGE_PURCHASE_DEFAULT_MIN = 500;

function parseMinAmount(raw: unknown, fallback = LARGE_PURCHASE_DEFAULT_MIN): number {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parseLimit(raw: unknown, fallback = 100, max = 500): number {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function normalizeCurrency(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  const v = String(raw).trim().toUpperCase();
  return v.length === 3 ? v : null;
}

// ----- Validation helpers ------------------------------------------------

interface NormalizedPurchasePatch {
  receiptStatus?: PurchaseReceiptStatus;
  warrantyStatus?: PurchaseWarrantyStatus;
  warrantyExpiresAt?: string | null;
  warrantyProvider?: string | null;
  businessRelevant?: boolean;
  usefulLifeMonths?: number | null;
  notes?: string | null;
}

type PatchResult =
  | { ok: true; value: NormalizedPurchasePatch }
  | { ok: false; status: number; error: string };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validatePurchasePatch(raw: Record<string, unknown>): PatchResult {
  const out: NormalizedPurchasePatch = {};
  if ('receiptStatus' in raw) {
    const v = String(raw.receiptStatus ?? '').toLowerCase();
    if (!(PURCHASE_RECEIPT_STATUSES as readonly string[]).includes(v)) {
      return {
        ok: false,
        status: 400,
        error: `receiptStatus must be one of: ${PURCHASE_RECEIPT_STATUSES.join(', ')}`,
      };
    }
    out.receiptStatus = v as PurchaseReceiptStatus;
  }
  if ('warrantyStatus' in raw) {
    const v = String(raw.warrantyStatus ?? '').toLowerCase();
    if (!(PURCHASE_WARRANTY_STATUSES as readonly string[]).includes(v)) {
      return {
        ok: false,
        status: 400,
        error: `warrantyStatus must be one of: ${PURCHASE_WARRANTY_STATUSES.join(', ')}`,
      };
    }
    out.warrantyStatus = v as PurchaseWarrantyStatus;
  }
  if ('warrantyExpiresAt' in raw) {
    const v = raw.warrantyExpiresAt;
    if (v == null || v === '') {
      out.warrantyExpiresAt = null;
    } else if (typeof v === 'string' && ISO_DATE_RE.test(v)) {
      out.warrantyExpiresAt = v;
    } else {
      return {
        ok: false,
        status: 400,
        error: 'warrantyExpiresAt must be YYYY-MM-DD or null',
      };
    }
  }
  if ('warrantyProvider' in raw) {
    const v = raw.warrantyProvider;
    if (v == null || v === '') {
      out.warrantyProvider = null;
    } else if (typeof v === 'string') {
      out.warrantyProvider = v.slice(0, 256);
    } else {
      return {
        ok: false,
        status: 400,
        error: 'warrantyProvider must be string or null',
      };
    }
  }
  if ('businessRelevant' in raw) {
    out.businessRelevant = Boolean(raw.businessRelevant);
  }
  if ('usefulLifeMonths' in raw) {
    const v = raw.usefulLifeMonths;
    if (v == null || v === '') {
      out.usefulLifeMonths = null;
    } else {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 600) {
        return {
          ok: false,
          status: 400,
          error: 'usefulLifeMonths must be an integer between 1 and 600 (or null)',
        };
      }
      out.usefulLifeMonths = n;
    }
  }
  if ('notes' in raw) {
    const v = raw.notes;
    if (v == null || v === '') out.notes = null;
    else if (typeof v === 'string') out.notes = v.slice(0, 4000);
    else {
      return { ok: false, status: 400, error: 'notes must be string or null' };
    }
  }
  return { ok: true, value: out };
}

// ----- Shared serializer -------------------------------------------------

export interface PurchaseDto {
  transactionId: number;
  householdId: number;
  markedAt: string;
  markedByUserId: number | null;
  receiptStatus: PurchaseReceiptStatus;
  warrantyStatus: PurchaseWarrantyStatus;
  warrantyExpiresAt: string | null;
  warrantyProvider: string | null;
  businessRelevant: boolean;
  usefulLifeMonths: number | null;
  notes: string | null;
  transaction: {
    id: number;
    date: string;
    merchant: string;
    amount: string;
    currency: string;
    finalCategory: string | null;
    finalBusiness: boolean;
    accountName: string | null;
  };
  costPerMonth: number;
  monthsOwned: number;
  hasReceipt: boolean;
}

interface TxnIncluded {
  id: number;
  date: string;
  merchantClean: string;
  amount: string;
  currency: string;
  finalCategory: string | null;
  finalBusiness: boolean;
  account?: { id: number; name: string } | null;
}

function serializePurchase(
  purchase: Purchase,
  txn: TxnIncluded,
  hasReceipt: boolean,
  asOf: string,
): PurchaseDto {
  const amountAbs = Math.abs(Number(txn.amount) || 0);
  const cost = costPerMonth({
    amountAbs,
    purchaseDate: txn.date,
    asOf,
    usefulLifeMonths: purchase.usefulLifeMonths,
  });
  return {
    transactionId: purchase.transactionId,
    householdId: purchase.householdId,
    markedAt:
      purchase.markedAt instanceof Date
        ? purchase.markedAt.toISOString()
        : String(purchase.markedAt),
    markedByUserId: purchase.markedByUserId,
    receiptStatus: purchase.receiptStatus,
    warrantyStatus: purchase.warrantyStatus,
    warrantyExpiresAt: purchase.warrantyExpiresAt,
    warrantyProvider: purchase.warrantyProvider,
    businessRelevant: Boolean(purchase.businessRelevant),
    usefulLifeMonths: purchase.usefulLifeMonths,
    notes: purchase.notes,
    transaction: {
      id: txn.id,
      date: txn.date,
      merchant: txn.merchantClean,
      amount: String(txn.amount),
      currency: String(txn.currency),
      finalCategory: txn.finalCategory,
      finalBusiness: Boolean(txn.finalBusiness),
      accountName: txn.account?.name ?? null,
    },
    costPerMonth: cost.costPerMonth,
    monthsOwned: cost.monthsOwned,
    hasReceipt,
  };
}

// ----- POST /api/transactions/:id/purchase --------------------------------

router.post('/transactions/:id/purchase', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const txn = await Transaction.findOne({
      where: { id, ...visibleTransactionWhere(req) },
      include: [{ model: Account, as: 'account', attributes: ['id', 'name'], required: false }],
    });
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (txn.householdId == null) {
      res.status(400).json({ error: 'Transaction has no household' });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const patch = validatePurchasePatch(body);
    if (!patch.ok) {
      res.status(patch.status).json({ error: patch.error });
      return;
    }
    const auth = currentAuth(req);

    const existing = await Purchase.findOne({ where: { transactionId: txn.id } });
    if (existing) {
      if ('receiptStatus' in patch.value) existing.receiptStatus = patch.value.receiptStatus!;
      if ('warrantyStatus' in patch.value) existing.warrantyStatus = patch.value.warrantyStatus!;
      if ('warrantyExpiresAt' in patch.value)
        existing.warrantyExpiresAt = patch.value.warrantyExpiresAt ?? null;
      if ('warrantyProvider' in patch.value)
        existing.warrantyProvider = patch.value.warrantyProvider ?? null;
      if ('businessRelevant' in patch.value)
        existing.businessRelevant = Boolean(patch.value.businessRelevant);
      if ('usefulLifeMonths' in patch.value)
        existing.usefulLifeMonths = patch.value.usefulLifeMonths ?? null;
      if ('notes' in patch.value) existing.notes = patch.value.notes ?? null;
      await existing.save();
    } else {
      await Purchase.create({
        transactionId: txn.id,
        householdId: txn.householdId,
        markedAt: new Date(),
        markedByUserId: auth.user.id,
        receiptStatus: patch.value.receiptStatus ?? 'unknown',
        warrantyStatus: patch.value.warrantyStatus ?? 'unknown',
        warrantyExpiresAt: patch.value.warrantyExpiresAt ?? null,
        warrantyProvider: patch.value.warrantyProvider ?? null,
        businessRelevant:
          patch.value.businessRelevant ?? Boolean(txn.finalBusiness),
        usefulLifeMonths: patch.value.usefulLifeMonths ?? null,
        notes: patch.value.notes ?? null,
      });
    }

    const reloaded = await Purchase.findOne({ where: { transactionId: txn.id } });
    if (!reloaded) {
      res.status(500).json({ error: 'Purchase not persisted' });
      return;
    }
    const hasReceipt =
      (await Receipt.count({ where: { transactionId: txn.id } })) > 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acc = (txn as any).account as { id: number; name: string } | undefined;
    res.status(existing ? 200 : 201).json({
      data: serializePurchase(
        reloaded,
        {
          id: txn.id,
          date: txn.date,
          merchantClean: txn.merchantClean,
          amount: txn.amount,
          currency: txn.currency,
          finalCategory: txn.finalCategory,
          finalBusiness: Boolean(txn.finalBusiness),
          account: acc ?? null,
        },
        hasReceipt,
        todayIso(),
      ),
    });
  } catch (e) {
    next(e);
  }
});

// ----- GET /api/transactions/:id/purchase ---------------------------------

router.get('/transactions/:id/purchase', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const txn = await Transaction.findOne({
      where: { id, ...visibleTransactionWhere(req) },
      include: [{ model: Account, as: 'account', attributes: ['id', 'name'], required: false }],
    });
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const purchase = await Purchase.findOne({ where: { transactionId: txn.id } });
    if (!purchase) {
      res.status(404).json({ error: 'Not tracked' });
      return;
    }
    const hasReceipt =
      (await Receipt.count({ where: { transactionId: txn.id } })) > 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acc = (txn as any).account as { id: number; name: string } | undefined;
    res.json({
      data: serializePurchase(
        purchase,
        {
          id: txn.id,
          date: txn.date,
          merchantClean: txn.merchantClean,
          amount: txn.amount,
          currency: txn.currency,
          finalCategory: txn.finalCategory,
          finalBusiness: Boolean(txn.finalBusiness),
          account: acc ?? null,
        },
        hasReceipt,
        todayIso(),
      ),
    });
  } catch (e) {
    next(e);
  }
});

// ----- DELETE /api/transactions/:id/purchase ------------------------------

router.delete('/transactions/:id/purchase', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const txn = await Transaction.findOne({
      where: { id, ...visibleTransactionWhere(req) },
    });
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const deleted = await Purchase.destroy({ where: { transactionId: txn.id } });
    if (deleted === 0) {
      res.status(404).json({ error: 'Not tracked' });
      return;
    }
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

// ----- GET /api/purchases -------------------------------------------------

router.get('/purchases', async (req, res, next) => {
  try {
    const filter = parsePurchaseFilter(req.query.filter);
    const minAmount = parseMinAmount(req.query.minAmount);
    const currency = normalizeCurrency(req.query.currency);
    const limit = parseLimit(req.query.limit);
    const asOf = todayIso();

    const txnWhere: WhereOptions = {
      ...visibleTransactionWhere(req),
      ...(currency ? { currency } : {}),
    };

    const rows = await Purchase.findAll({
      include: [
        {
          model: Transaction,
          as: 'transaction',
          required: true,
          where: txnWhere,
          attributes: [
            'id',
            'date',
            'merchantClean',
            'amount',
            'currency',
            'finalCategory',
            'finalBusiness',
            'householdId',
          ],
          include: [
            {
              model: Account,
              as: 'account',
              attributes: ['id', 'name'],
              required: false,
            },
          ],
        },
      ],
      order: [
        // Newest tracked first; ties broken by transaction date.
        ['markedAt', 'DESC'],
      ],
      limit,
    });

    const txnIds = rows
      .map((r) => r.transactionId)
      .filter((x): x is number => x != null);
    const receipts = txnIds.length
      ? await Receipt.findAll({
          where: { transactionId: { [Op.in]: txnIds } },
          attributes: ['transactionId'],
        })
      : [];
    const txnIdsWithReceipt = new Set<number>(receipts.map((r) => r.transactionId));

    let items = rows.map((purchase) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const txn = (purchase as any).transaction as TxnIncluded & { id: number };
      return serializePurchase(
        purchase,
        txn,
        txnIdsWithReceipt.has(txn.id),
        asOf,
      );
    });

    // Apply post-filters (depend on joined data).
    if (filter === 'missing-docs') {
      items = items.filter(
        (p) =>
          !p.hasReceipt ||
          p.receiptStatus === 'missing' ||
          p.receiptStatus === 'unknown',
      );
    } else if (filter === 'business') {
      items = items.filter((p) => p.businessRelevant || p.transaction.finalBusiness);
    } else if (filter === 'large') {
      items = items.filter(
        (p) => Math.abs(Number(p.transaction.amount) || 0) >= minAmount,
      );
    }

    res.json({
      data: items,
      count: items.length,
      filter,
      minAmount: filter === 'large' ? minAmount : null,
      currency,
    });
  } catch (e) {
    next(e);
  }
});

// ----- GET /api/purchases/large-inbox -------------------------------------

/**
 * Large UNMARKED transactions — review queue for promoting big purchases to
 * tracked status. Filters to `txn_type='purchase'` (default) and absolute
 * amount >= `minAmount` (default $500). Returns transactions that do NOT
 * have a row in the purchases table, sorted by absolute amount desc.
 */
router.get('/purchases/large-inbox', async (req, res, next) => {
  try {
    const minAmount = parseMinAmount(req.query.minAmount);
    const currency = normalizeCurrency(req.query.currency);
    const limit = parseLimit(req.query.limit, 50, 200);

    const where: WhereOptions = {
      ...visibleTransactionWhere(req),
      txnType: 'purchase',
      ...(currency ? { currency } : {}),
    };

    // Pull a generous batch, then filter by abs(amount) + drop tracked ones.
    const candidates = await Transaction.findAll({
      where,
      attributes: [
        'id',
        'date',
        'merchantClean',
        'amount',
        'currency',
        'finalCategory',
        'finalBusiness',
      ],
      include: [
        {
          model: Account,
          as: 'account',
          attributes: ['id', 'name'],
          required: false,
        },
      ],
      order: [['date', 'DESC']],
      // Over-fetch — most won't be large; filter in JS to keep the query
      // simple across SQLite + Postgres.
      limit: Math.max(limit * 10, 200),
    });

    const filteredByAmount = candidates.filter(
      (t) => Math.abs(Number(t.amount) || 0) >= minAmount,
    );
    const ids = filteredByAmount.map((t) => t.id);
    const trackedIds = new Set<number>(
      ids.length
        ? (
            await Purchase.findAll({
              where: { transactionId: { [Op.in]: ids } },
              attributes: ['transactionId'],
            })
          ).map((p) => p.transactionId)
        : [],
    );
    const unmarked = filteredByAmount
      .filter((t) => !trackedIds.has(t.id))
      .sort(
        (a, b) =>
          Math.abs(Number(b.amount) || 0) - Math.abs(Number(a.amount) || 0),
      )
      .slice(0, limit);

    const data = unmarked.map((t) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const acc = (t as any).account as { id: number; name: string } | undefined;
      return {
        id: t.id,
        date: t.date,
        merchant: t.merchantClean,
        amount: String(t.amount),
        currency: String(t.currency),
        finalCategory: t.finalCategory,
        finalBusiness: Boolean(t.finalBusiness),
        accountName: acc?.name ?? null,
      };
    });
    res.json({ data, count: data.length, minAmount, currency });
  } catch (e) {
    next(e);
  }
});

export default router;
