/**
 * Large purchase review workflow route surface (issue #244).
 *
 * Endpoints:
 *   PATCH /api/transactions/:id/large-purchase-review
 *       — upsert the per-transaction review checklist + status
 *   GET /api/large-purchases/inbox
 *       — purchases above threshold that are NOT yet reviewed/dismissed
 *   GET /api/large-purchases/all
 *       — all flagged purchases (inbox + reviewed + dismissed)
 *
 * Threshold comparison: abs(amount) >= threshold. Threshold is pulled from
 * the user's CashflowSettings row (default 500). A threshold of 0 flags
 * everything (by design); the user can reconfigure via the settings endpoint.
 *
 * Pure helpers (validateLargePurchaseReviewPatch, serializeLargePurchaseReview)
 * are exported so they can be unit-tested without spinning up a DB.
 */
import { Router } from 'express';
import { Op } from 'sequelize';
import {
  Transaction,
  TransactionLargePurchaseReview,
  CashflowSettings,
  Account,
} from '../models';
import { currentAuth } from '../auth/middleware';
import { visibleTransactionWhere } from '../auth/scope';
import {
  LARGE_PURCHASE_REVIEW_STATUSES,
  type LargePurchaseReviewStatus,
} from '../models/TransactionLargePurchaseReview';
import { CASHFLOW_SETTINGS_DEFAULTS } from '../models/CashflowSettings';

const router = Router();

// ---------- Input validation (pure) ----------

export interface NormalizedLargePurchaseReviewPatch {
  status?: LargePurchaseReviewStatus;
  categoryConfirmed?: boolean | null;
  businessRelevant?: boolean | null;
  receiptConfirmed?: boolean | null;
  warrantyTracked?: boolean | null;
  reimbursementTracked?: boolean | null;
  notes?: string | null;
  reviewedAt?: string | null;
}

export type LargePurchaseReviewPatchResult =
  | { ok: true; value: NormalizedLargePurchaseReviewPatch }
  | { ok: false; status: number; error: string };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoOrNull(raw: unknown): string | null | undefined {
  if (raw == null || raw === '') return null;
  const s = String(raw).slice(0, 10);
  if (!ISO_DATE_RE.test(s)) return undefined;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  if (`${yyyy}-${mm}-${dd}` !== s) return undefined;
  return s;
}

function parseBoolOrNull(raw: unknown): boolean | null | undefined {
  if (raw == null) return null;
  if (typeof raw === 'boolean') return raw;
  if (raw === 1 || raw === '1' || raw === 'true') return true;
  if (raw === 0 || raw === '0' || raw === 'false') return false;
  return undefined;
}

export function validateLargePurchaseReviewPatch(
  raw: Record<string, unknown>,
): LargePurchaseReviewPatchResult {
  const out: NormalizedLargePurchaseReviewPatch = {};

  if ('status' in raw) {
    const v = String(raw.status ?? '');
    if (!(LARGE_PURCHASE_REVIEW_STATUSES as readonly string[]).includes(v)) {
      return {
        ok: false,
        status: 400,
        error: `status must be one of: ${LARGE_PURCHASE_REVIEW_STATUSES.join(', ')}`,
      };
    }
    out.status = v as LargePurchaseReviewStatus;
  }

  for (const boolField of [
    'categoryConfirmed',
    'businessRelevant',
    'receiptConfirmed',
    'warrantyTracked',
    'reimbursementTracked',
  ] as const) {
    if (boolField in raw) {
      const parsed = parseBoolOrNull(raw[boolField]);
      if (parsed === undefined) {
        return {
          ok: false,
          status: 400,
          error: `${boolField} must be a boolean or null`,
        };
      }
      out[boolField] = parsed;
    }
  }

  if ('notes' in raw) {
    if (raw.notes == null) {
      out.notes = null;
    } else {
      out.notes = String(raw.notes).slice(0, 4000);
    }
  }

  if ('reviewedAt' in raw) {
    const parsed = parseIsoOrNull(raw.reviewedAt);
    if (parsed === undefined) {
      return {
        ok: false,
        status: 400,
        error: 'reviewedAt must be ISO YYYY-MM-DD or null',
      };
    }
    out.reviewedAt = parsed;
  }

  return { ok: true, value: out };
}

// ---------- Serializer ----------

export interface LargePurchaseReviewView {
  transactionId: number | null;
  status: LargePurchaseReviewStatus;
  categoryConfirmed: boolean | null;
  businessRelevant: boolean | null;
  receiptConfirmed: boolean | null;
  warrantyTracked: boolean | null;
  reimbursementTracked: boolean | null;
  notes: string | null;
  reviewedAt: string | null;
}

export function serializeLargePurchaseReview(
  review: TransactionLargePurchaseReview | null,
): LargePurchaseReviewView {
  if (!review) {
    return {
      transactionId: null,
      status: 'pending',
      categoryConfirmed: null,
      businessRelevant: null,
      receiptConfirmed: null,
      warrantyTracked: null,
      reimbursementTracked: null,
      notes: null,
      reviewedAt: null,
    };
  }
  return {
    transactionId: review.transactionId,
    status: (review.status ?? 'pending') as LargePurchaseReviewStatus,
    categoryConfirmed: review.categoryConfirmed ?? null,
    businessRelevant: review.businessRelevant ?? null,
    receiptConfirmed: review.receiptConfirmed ?? null,
    warrantyTracked: review.warrantyTracked ?? null,
    reimbursementTracked: review.reimbursementTracked ?? null,
    notes: review.notes ?? null,
    reviewedAt: review.reviewedAt ?? null,
  };
}

// ---------- Listing serializer ----------

export interface LargePurchaseRowView {
  id: number;
  date: string;
  merchant: string;
  amount: string;
  currency: string;
  finalCategory: string | null;
  accountName: string | null;
  review: LargePurchaseReviewView;
}

interface ListRowInput {
  id: number;
  date: string;
  merchantClean: string;
  amount: unknown;
  currency: string;
  finalCategory: string | null;
  account?: { id: number; name: string } | null | undefined;
  largePurchaseReview?: TransactionLargePurchaseReview | null | undefined;
}

export function rowToLargePurchaseView(row: ListRowInput): LargePurchaseRowView {
  return {
    id: row.id,
    date: row.date,
    merchant: row.merchantClean,
    amount: String(row.amount),
    currency: row.currency,
    finalCategory: row.finalCategory,
    accountName: row.account?.name ?? null,
    review: serializeLargePurchaseReview(row.largePurchaseReview ?? null),
  };
}

// ---------- Shared threshold helper ----------

async function getUserThreshold(userId: number): Promise<number> {
  const settings = await CashflowSettings.findOne({ where: { userId } });
  const raw = settings?.largePurchaseThreshold ?? CASHFLOW_SETTINGS_DEFAULTS.largePurchaseThreshold;
  return Number(raw);
}

function parseLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(500, Math.max(1, Math.floor(n)));
}

// ---------- Route: PATCH /api/transactions/:id/large-purchase-review ----------

router.patch('/transactions/:id/large-purchase-review', async (req, res, next) => {
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
    const body = (req.body || {}) as Record<string, unknown>;
    const patch = validateLargePurchaseReviewPatch(body);
    if (!patch.ok) {
      res.status(patch.status).json({ error: patch.error });
      return;
    }

    const existing = await TransactionLargePurchaseReview.findOne({
      where: { transactionId: txn.id },
    });

    if (existing) {
      if ('status' in patch.value && patch.value.status !== undefined) {
        existing.status = patch.value.status;
      }
      for (const boolField of [
        'categoryConfirmed',
        'businessRelevant',
        'receiptConfirmed',
        'warrantyTracked',
        'reimbursementTracked',
      ] as const) {
        if (boolField in patch.value) {
          existing.set(boolField, patch.value[boolField] ?? null);
        }
      }
      if ('notes' in patch.value) existing.notes = patch.value.notes ?? null;
      if ('reviewedAt' in patch.value) existing.reviewedAt = patch.value.reviewedAt ?? null;
      await existing.save();
    } else {
      await TransactionLargePurchaseReview.create({
        transactionId: txn.id,
        status: patch.value.status ?? 'pending',
        categoryConfirmed: patch.value.categoryConfirmed ?? null,
        businessRelevant: patch.value.businessRelevant ?? null,
        receiptConfirmed: patch.value.receiptConfirmed ?? null,
        warrantyTracked: patch.value.warrantyTracked ?? null,
        reimbursementTracked: patch.value.reimbursementTracked ?? null,
        notes: patch.value.notes ?? null,
        reviewedAt: patch.value.reviewedAt ?? null,
      });
    }

    const reloaded = await TransactionLargePurchaseReview.findOne({
      where: { transactionId: txn.id },
    });
    res.json({ data: serializeLargePurchaseReview(reloaded) });
  } catch (e) {
    next(e);
  }
});

// ---------- Shared listing helper ----------

async function fetchLargePurchases(
  req: Parameters<typeof visibleTransactionWhere>[0],
  userId: number,
  statusFilter?: LargePurchaseReviewStatus[],
  limit = 100,
) {
  const threshold = await getUserThreshold(userId);

  // Build the review join condition.
  // For inbox: rows where review IS NULL or review.status = 'pending'
  // For all: no status filter on the join — include all reviews.
  // We fetch ALL transactions above threshold; then filter by status in JS
  // to handle the NULL-review case correctly (LEFT JOIN).
  const rows = await Transaction.findAll({
    where: {
      ...visibleTransactionWhere(req),
      // Only debits (negative amounts) qualify as purchases.
      amount: { [Op.lte]: -threshold },
    },
    attributes: [
      'id',
      'date',
      'merchantClean',
      'amount',
      'currency',
      'finalCategory',
    ],
    include: [
      {
        model: TransactionLargePurchaseReview,
        as: 'largePurchaseReview',
        required: false,
      },
      {
        model: Account,
        as: 'account',
        attributes: ['id', 'name'],
        required: false,
      },
    ],
    order: [['amount', 'ASC']], // most negative (most expensive) first
    limit,
  });

  // Apply status filter in application code to handle NULL-review rows.
  const filtered = statusFilter
    ? rows.filter((r) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const review = (r as any).largePurchaseReview as
          | TransactionLargePurchaseReview
          | null
          | undefined;
        const status = review?.status ?? 'pending';
        return (statusFilter as string[]).includes(status);
      })
    : rows;

  return filtered.map((r) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const review = (r as any).largePurchaseReview as
      | TransactionLargePurchaseReview
      | null
      | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const account = (r as any).account as
      | { id: number; name: string }
      | null
      | undefined;
    return rowToLargePurchaseView({
      id: r.id,
      date: r.date,
      merchantClean: r.merchantClean,
      amount: r.amount,
      currency: r.currency,
      finalCategory: r.finalCategory,
      account,
      largePurchaseReview: review ?? null,
    });
  });
}

// ---------- GET /api/large-purchases/inbox ----------

router.get('/large-purchases/inbox', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const limit = parseLimit(req.query.limit);
    const data = await fetchLargePurchases(req, user.id, ['pending'], limit);
    const threshold = await getUserThreshold(user.id);
    res.json({ data, count: data.length, threshold: String(threshold.toFixed(4)) });
  } catch (e) {
    next(e);
  }
});

// ---------- GET /api/large-purchases/all ----------

router.get('/large-purchases/all', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const limit = parseLimit(req.query.limit);
    const data = await fetchLargePurchases(req, user.id, undefined, limit);
    const threshold = await getUserThreshold(user.id);
    res.json({ data, count: data.length, threshold: String(threshold.toFixed(4)) });
  } catch (e) {
    next(e);
  }
});

export default router;
