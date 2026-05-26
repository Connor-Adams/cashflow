/**
 * Return-window and warranty tracker route surface.
 *
 * Endpoints:
 *   PATCH /api/transactions/:id/return-warranty
 *       — set/clear the per-transaction return + warranty metadata
 *   GET /api/return-warranty/active
 *       — purchases still inside the return window (deadline >= today)
 *   GET /api/return-warranty/expiring-soon
 *       — return windows expiring within ?days=N (default 7)
 *   GET /api/return-warranty/warranties
 *       — warranty-covered purchases (warranty_end_date >= today)
 *   GET /api/return-warranty/missing-receipts
 *       — purchases flagged missing OR no receipt attached and status != not_needed
 *
 * Deadline calculations are pure helpers so they can be unit-tested without
 * spinning up a DB. The route handlers themselves are thin wrappers around
 * Sequelize lookups + serialization.
 */
import { Router, type Request } from 'express';
import { Op, type WhereOptions } from 'sequelize';
import {
  Transaction,
  TransactionReturnMetadata,
  Receipt,
  Account,
} from '../models';
import { currentAuth } from '../auth/middleware';
import { visibleTransactionWhere } from '../auth/scope';
import {
  RECEIPT_STATUSES,
  type ReceiptStatus,
} from '../models/TransactionReturnMetadata';

const router = Router();

// ---------- Date helpers (pure, unit-tested) ----------

/** ISO YYYY-MM-DD for a given Date. UTC components so timezone drift can't
 *  shift the date that the user typed. */
export function isoDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Today's UTC date as YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  return isoDate(now);
}

/** True iff `deadline` is an ISO date today or in the future. */
export function isWithinReturnWindow(
  deadline: string | null | undefined,
  today: string = todayIso(),
): boolean {
  if (!deadline) return false;
  return deadline >= today;
}

/** True iff `deadline` falls within the next `withinDays` (inclusive), counting
 *  from `today`. Past deadlines are NOT "expiring soon" — they're expired. */
export function isExpiringSoon(
  deadline: string | null | undefined,
  withinDays: number,
  today: string = todayIso(),
): boolean {
  if (!deadline) return false;
  if (deadline < today) return false;
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() + withinDays);
  const cutoffIso = isoDate(cutoff);
  return deadline <= cutoffIso;
}

/** Days remaining between `today` and `deadline`. Negative when expired. */
export function daysUntil(
  deadline: string | null | undefined,
  today: string = todayIso(),
): number | null {
  if (!deadline) return null;
  const a = new Date(`${today}T00:00:00Z`).getTime();
  const b = new Date(`${deadline}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

// ---------- Input validation (pure) ----------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoOrNull(raw: unknown): string | null | undefined {
  if (raw == null || raw === '') return null;
  const s = String(raw).slice(0, 10);
  if (!ISO_DATE_RE.test(s)) return undefined;
  // Round-trip through Date to reject e.g. "2026-02-31".
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  if (isoDate(d) !== s) return undefined;
  return s;
}

export interface NormalizedReturnPatch {
  returnDeadline?: string | null;
  warrantyEndDate?: string | null;
  notes?: string | null;
  receiptStatus?: ReceiptStatus;
}

export type ReturnPatchResult =
  | { ok: true; value: NormalizedReturnPatch }
  | { ok: false; status: number; error: string };

export function validateReturnPatch(
  raw: Record<string, unknown>,
): ReturnPatchResult {
  const out: NormalizedReturnPatch = {};
  if ('returnDeadline' in raw) {
    const parsed = parseIsoOrNull(raw.returnDeadline);
    if (parsed === undefined) {
      return {
        ok: false,
        status: 400,
        error: 'returnDeadline must be ISO YYYY-MM-DD or null',
      };
    }
    out.returnDeadline = parsed;
  }
  if ('warrantyEndDate' in raw) {
    const parsed = parseIsoOrNull(raw.warrantyEndDate);
    if (parsed === undefined) {
      return {
        ok: false,
        status: 400,
        error: 'warrantyEndDate must be ISO YYYY-MM-DD or null',
      };
    }
    out.warrantyEndDate = parsed;
  }
  if ('notes' in raw) {
    if (raw.notes == null) {
      out.notes = null;
    } else {
      out.notes = String(raw.notes).slice(0, 4000);
    }
  }
  if ('receiptStatus' in raw) {
    const v = String(raw.receiptStatus ?? '');
    if (!(RECEIPT_STATUSES as readonly string[]).includes(v)) {
      return {
        ok: false,
        status: 400,
        error: `receiptStatus must be one of: ${RECEIPT_STATUSES.join(', ')}`,
      };
    }
    out.receiptStatus = v as ReceiptStatus;
  }
  return { ok: true, value: out };
}

// ---------- Serializer ----------

export interface ReturnMetadataView {
  transactionId: number | null;
  returnDeadline: string | null;
  warrantyEndDate: string | null;
  notes: string | null;
  receiptStatus: ReceiptStatus;
  /** Convenience flags evaluated against `today` for the frontend. */
  isWithinReturnWindow: boolean;
  isWarrantyActive: boolean;
  daysUntilReturnDeadline: number | null;
  daysUntilWarrantyEnd: number | null;
}

export function serializeReturnMetadata(
  meta: TransactionReturnMetadata | null,
  today: string = todayIso(),
): ReturnMetadataView {
  if (!meta) {
    return {
      transactionId: null,
      returnDeadline: null,
      warrantyEndDate: null,
      notes: null,
      receiptStatus: 'unknown',
      isWithinReturnWindow: false,
      isWarrantyActive: false,
      daysUntilReturnDeadline: null,
      daysUntilWarrantyEnd: null,
    };
  }
  return {
    transactionId: meta.transactionId,
    returnDeadline: meta.returnDeadline,
    warrantyEndDate: meta.warrantyEndDate,
    notes: meta.notes,
    receiptStatus: (meta.receiptStatus ?? 'unknown') as ReceiptStatus,
    isWithinReturnWindow: isWithinReturnWindow(meta.returnDeadline, today),
    isWarrantyActive: isWithinReturnWindow(meta.warrantyEndDate, today),
    daysUntilReturnDeadline: daysUntil(meta.returnDeadline, today),
    daysUntilWarrantyEnd: daysUntil(meta.warrantyEndDate, today),
  };
}

// ---------- Listing serializer ----------

export interface ReturnWarrantyRowView {
  id: number;
  date: string;
  merchant: string;
  amount: string;
  currency: string;
  finalCategory: string | null;
  accountName: string | null;
  returnDeadline: string | null;
  warrantyEndDate: string | null;
  receiptStatus: ReceiptStatus;
  hasReceipt: boolean;
  notes: string | null;
  daysUntilReturnDeadline: number | null;
  daysUntilWarrantyEnd: number | null;
}

interface ListRowInput {
  id: number;
  date: string;
  merchantClean: string;
  amount: unknown;
  currency: string;
  finalCategory: string | null;
  account?: { id: number; name: string } | null | undefined;
  receipts?: { id: number }[] | undefined;
  returnMetadata?: TransactionReturnMetadata | null | undefined;
}

export function rowToListView(
  row: ListRowInput,
  today: string = todayIso(),
): ReturnWarrantyRowView {
  const meta = row.returnMetadata ?? null;
  const receipts = row.receipts ?? [];
  return {
    id: row.id,
    date: row.date,
    merchant: row.merchantClean,
    amount: String(row.amount),
    currency: row.currency,
    finalCategory: row.finalCategory,
    accountName: row.account?.name ?? null,
    returnDeadline: meta?.returnDeadline ?? null,
    warrantyEndDate: meta?.warrantyEndDate ?? null,
    receiptStatus: (meta?.receiptStatus ?? 'unknown') as ReceiptStatus,
    hasReceipt: receipts.length > 0,
    notes: meta?.notes ?? null,
    daysUntilReturnDeadline: daysUntil(meta?.returnDeadline ?? null, today),
    daysUntilWarrantyEnd: daysUntil(meta?.warrantyEndDate ?? null, today),
  };
}

// ---------- Param parsing ----------

function parsePositiveInt(raw: unknown, fallback: number, max = 365): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
}

function parseLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(500, Math.max(1, Math.floor(n)));
}

// ---------- Route: PATCH /api/transactions/:id/return-warranty ----------

router.patch('/transactions/:id/return-warranty', async (req, res, next) => {
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
    const patch = validateReturnPatch(body);
    if (!patch.ok) {
      res.status(patch.status).json({ error: patch.error });
      return;
    }
    const existing = await TransactionReturnMetadata.findOne({
      where: { transactionId: txn.id },
    });
    if (existing) {
      if ('returnDeadline' in patch.value) {
        existing.returnDeadline = patch.value.returnDeadline ?? null;
      }
      if ('warrantyEndDate' in patch.value) {
        existing.warrantyEndDate = patch.value.warrantyEndDate ?? null;
      }
      if ('notes' in patch.value) existing.notes = patch.value.notes ?? null;
      if ('receiptStatus' in patch.value && patch.value.receiptStatus) {
        existing.receiptStatus = patch.value.receiptStatus;
      }
      await existing.save();
    } else {
      await TransactionReturnMetadata.create({
        transactionId: txn.id,
        returnDeadline: patch.value.returnDeadline ?? null,
        warrantyEndDate: patch.value.warrantyEndDate ?? null,
        notes: patch.value.notes ?? null,
        receiptStatus: patch.value.receiptStatus ?? 'unknown',
      });
    }
    const reloaded = await TransactionReturnMetadata.findOne({
      where: { transactionId: txn.id },
    });
    res.json({ data: serializeReturnMetadata(reloaded) });
  } catch (e) {
    next(e);
  }
});

// ---------- Shared visibility filter for transaction listings ----------

function visibleListWhere(req: Request): WhereOptions {
  // Only count charges (negative amounts) — refunds/transfers/payments aren't
  // "purchases" with a return window.
  return {
    ...visibleTransactionWhere(req),
    amount: { [Op.lt]: 0 },
  };
}

interface BuildListOptions {
  /** Extra metadata-level where clause (after joining returnMetadata). */
  metaWhere?: WhereOptions;
  required: boolean;
  limit: number;
}

async function fetchListing(req: Request, opts: BuildListOptions) {
  return Transaction.findAll({
    where: visibleListWhere(req),
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
        model: TransactionReturnMetadata,
        as: 'returnMetadata',
        required: opts.required,
        where: opts.metaWhere,
      },
      {
        model: Receipt,
        as: 'receipts',
        attributes: ['id'],
        required: false,
      },
      {
        model: Account,
        as: 'account',
        attributes: ['id', 'name'],
        required: false,
      },
    ],
    order: [['date', 'DESC']],
    limit: opts.limit,
  });
}

function rowsToView(rows: Transaction[], today: string): ReturnWarrantyRowView[] {
  return rows.map((r) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (r as any).returnMetadata as
      | TransactionReturnMetadata
      | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const receipts = ((r as any).receipts ?? []) as { id: number }[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const account = (r as any).account as
      | { id: number; name: string }
      | undefined;
    return rowToListView(
      {
        id: r.id,
        date: r.date,
        merchantClean: r.merchantClean,
        amount: r.amount,
        currency: r.currency,
        finalCategory: r.finalCategory,
        account,
        receipts,
        returnMetadata: meta ?? null,
      },
      today,
    );
  });
}

// ---------- GET /api/return-warranty/active ----------

router.get('/return-warranty/active', async (req, res, next) => {
  try {
    currentAuth(req); // assert auth
    const today = todayIso();
    const limit = parseLimit(req.query.limit);
    const rows = await fetchListing(req, {
      required: true,
      limit,
      metaWhere: {
        returnDeadline: { [Op.gte]: today },
      },
    });
    const data = rowsToView(rows, today);
    res.json({ data, count: data.length, today });
  } catch (e) {
    next(e);
  }
});

// ---------- GET /api/return-warranty/expiring-soon ----------

router.get('/return-warranty/expiring-soon', async (req, res, next) => {
  try {
    currentAuth(req);
    const today = todayIso();
    const days = parsePositiveInt(req.query.days, 7);
    const limit = parseLimit(req.query.limit);
    const cutoffDate = new Date(`${today}T00:00:00Z`);
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() + days);
    const cutoff = isoDate(cutoffDate);
    const rows = await fetchListing(req, {
      required: true,
      limit,
      metaWhere: {
        returnDeadline: { [Op.between]: [today, cutoff] },
      },
    });
    const data = rowsToView(rows, today);
    res.json({ data, count: data.length, today, withinDays: days, cutoff });
  } catch (e) {
    next(e);
  }
});

// ---------- GET /api/return-warranty/warranties ----------

router.get('/return-warranty/warranties', async (req, res, next) => {
  try {
    currentAuth(req);
    const today = todayIso();
    const limit = parseLimit(req.query.limit);
    const rows = await fetchListing(req, {
      required: true,
      limit,
      metaWhere: {
        warrantyEndDate: { [Op.gte]: today },
      },
    });
    const data = rowsToView(rows, today);
    res.json({ data, count: data.length, today });
  } catch (e) {
    next(e);
  }
});

// ---------- GET /api/return-warranty/missing-receipts ----------

/**
 * Lists purchases that need a receipt but don't have one. A row is "missing"
 * when:
 *   - receipt_status = 'missing', OR
 *   - return_deadline is in the future OR warranty_end_date is in the future
 *     AND no receipt is attached AND receipt_status != 'not_needed'.
 *
 * Excludes 'not_needed' rows entirely (user has opted out of tracking).
 */
router.get('/return-warranty/missing-receipts', async (req, res, next) => {
  try {
    currentAuth(req);
    const today = todayIso();
    const limit = parseLimit(req.query.limit);
    // Only rows that HAVE return metadata; if a purchase has no metadata, the
    // user hasn't started tracking it and we shouldn't pile it onto the list.
    const rows = await fetchListing(req, {
      required: true,
      limit,
      metaWhere: {
        receiptStatus: { [Op.ne]: 'not_needed' },
        [Op.or]: [
          { receiptStatus: 'missing' },
          { returnDeadline: { [Op.gte]: today } },
          { warrantyEndDate: { [Op.gte]: today } },
        ],
      },
    });
    const data = rowsToView(rows, today).filter((r) => {
      if (r.receiptStatus === 'not_needed') return false;
      if (r.receiptStatus === 'missing') return true;
      if (r.hasReceipt) return false;
      return r.returnDeadline != null || r.warrantyEndDate != null;
    });
    res.json({ data, count: data.length, today });
  } catch (e) {
    next(e);
  }
});

export default router;
