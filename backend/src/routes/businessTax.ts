import { Router, type Request } from 'express';
import { Op, type WhereOptions } from 'sequelize';
import {
  Transaction,
  Receipt,
  TaxTag,
  TransactionTaxMetadata,
  Account,
} from '../models';
import { currentAuth } from '../auth/middleware';
import { visibleTransactionWhere } from '../auth/scope';
import { num } from '../util/numbers';

const router = Router();

/**
 * Tax-hygiene scope filter. Mirrors the 4-value scope vocab introduced by
 * issue #201 for budgets but with one twist: business expenses are always
 * deductible-eligible regardless of split, so `business` includes any
 * transaction with `finalBusiness=true`. Personal excludes business and
 * shared splits; `shared` is split me+partner; `all` is no filter.
 *
 * Exported as a pure helper for unit tests.
 */
export type TaxScope = 'personal' | 'shared' | 'business' | 'all';

export const TAX_SCOPES: readonly TaxScope[] = [
  'personal',
  'shared',
  'business',
  'all',
] as const;

export function parseTaxScope(raw: unknown, fallback: TaxScope = 'business'): TaxScope {
  const s = String(raw ?? '').toLowerCase();
  return (TAX_SCOPES as readonly string[]).includes(s)
    ? (s as TaxScope)
    : fallback;
}

export function scopeWhere(scope: TaxScope): WhereOptions {
  switch (scope) {
    case 'personal':
      return { finalBusiness: false, finalSplitType: 'me' };
    case 'shared':
      return { finalBusiness: false, finalSplitType: { [Op.ne]: 'me' } };
    case 'business':
      return { finalBusiness: true };
    case 'all':
    default:
      return {};
  }
}

/** Inclusive [from, to] date filter, both optional. Returns {} when neither set. */
export function dateRangeWhere(from?: string, to?: string): WhereOptions {
  if (!from && !to) return {};
  const cond: { [Op.gte]?: string; [Op.lte]?: string } = {};
  if (from) cond[Op.gte] = from;
  if (to) cond[Op.lte] = to;
  return { date: cond } as WhereOptions;
}

// ---------- Pure aggregator helpers (unit-tested) ----------

export interface TaxSummaryInputRow {
  /** Transaction.amount as DECIMAL string (charges are NEGATIVE). */
  amount: string;
  currency: string;
  finalBusiness: boolean;
  /** TransactionTaxMetadata.deductiblePercent ([0,1]) — null when no metadata. */
  deductiblePercent: string | null;
  /** TransactionTaxMetadata.hstGstAmount — null when not classified. */
  hstGstAmount: string | null;
  /** TransactionTaxMetadata.reviewedForTax (false when no metadata). */
  reviewedForTax: boolean;
}

export interface TaxSummaryRollup {
  currency: string;
  /** Sum of |amount| for charges (amount < 0). */
  gross: string;
  /** Sum of |amount| * deductiblePercent for charges (amount < 0). */
  deductibleEstimate: string;
  /** Sum of hstGstAmount where set. Positive. */
  hstGstEstimate: string;
  /** Count of rows. */
  transactionCount: number;
  /** Count of rows with reviewedForTax = true. */
  reviewedCount: number;
}

/**
 * Aggregates transaction rows into per-currency rollups. Only counts charges
 * (amount < 0); positive amounts (refunds, transfers, payments) are ignored
 * because they would distort gross outflow against deductible totals.
 *
 * Missing tax-metadata rows default to deductible 100% when finalBusiness is
 * true (matches the migration default), 0% otherwise — so unreviewed business
 * rows still surface as a deductible candidate in the dashboard.
 */
export function aggregateTaxSummary(
  rows: TaxSummaryInputRow[],
): TaxSummaryRollup[] {
  const out = new Map<string, TaxSummaryRollup>();
  for (const row of rows) {
    const amount = num(row.amount);
    if (amount == null || amount >= 0) continue;
    const gross = -amount;
    const declaredDeductible = num(row.deductiblePercent);
    const defaultDeductible = row.finalBusiness ? 1 : 0;
    const deductiblePct =
      declaredDeductible != null ? declaredDeductible : defaultDeductible;
    const deductibleEstimate = gross * deductiblePct;
    const hstGst = num(row.hstGstAmount) ?? 0;
    const key = row.currency;
    const existing = out.get(key) ?? {
      currency: row.currency,
      gross: '0',
      deductibleEstimate: '0',
      hstGstEstimate: '0',
      transactionCount: 0,
      reviewedCount: 0,
    };
    existing.gross = (Number(existing.gross) + gross).toFixed(2);
    existing.deductibleEstimate = (
      Number(existing.deductibleEstimate) + deductibleEstimate
    ).toFixed(2);
    existing.hstGstEstimate = (Number(existing.hstGstEstimate) + hstGst).toFixed(2);
    existing.transactionCount += 1;
    if (row.reviewedForTax) existing.reviewedCount += 1;
    out.set(key, existing);
  }
  return Array.from(out.values()).sort((a, b) =>
    a.currency.localeCompare(b.currency),
  );
}

/**
 * Builds the where-clause used by /tax-summary, /missing-receipts, and the
 * export. Centralises scope + date-range parsing so all three endpoints
 * agree on what "this period" means.
 */
export function buildHygieneWhere(req: Request): WhereOptions {
  const scope = parseTaxScope(req.query.scope);
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  return {
    ...visibleTransactionWhere(req),
    ...scopeWhere(scope),
    ...dateRangeWhere(from, to),
  };
}

// ---------- CSV serializer (unit-tested) ----------

export function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export interface TaxExportRow {
  id: number;
  date: string;
  merchant: string;
  accountName: string | null;
  currency: string;
  amount: string;
  finalCategory: string | null;
  finalBusiness: boolean;
  finalSplitType: string;
  taxTagName: string | null;
  deductiblePercent: string;
  deductibleAmount: string;
  hstGstAmount: string | null;
  receiptRequired: boolean;
  hasReceipt: boolean;
  reviewedForTax: boolean;
  notes: string | null;
}

export function rowsToTaxCsv(rows: TaxExportRow[]): string {
  const header = [
    'id',
    'date',
    'merchant',
    'account',
    'currency',
    'amount',
    'category',
    'business',
    'split',
    'tax_tag',
    'deductible_percent',
    'deductible_amount',
    'hst_gst_amount',
    'receipt_required',
    'has_receipt',
    'reviewed_for_tax',
    'notes',
  ].join(',');
  const lines = rows.map((r) =>
    [
      r.id,
      r.date,
      csvEscape(r.merchant),
      csvEscape(r.accountName ?? ''),
      r.currency,
      r.amount,
      csvEscape(r.finalCategory ?? ''),
      r.finalBusiness ? 'true' : 'false',
      r.finalSplitType,
      csvEscape(r.taxTagName ?? ''),
      r.deductiblePercent,
      r.deductibleAmount,
      r.hstGstAmount ?? '',
      r.receiptRequired ? 'true' : 'false',
      r.hasReceipt ? 'true' : 'false',
      r.reviewedForTax ? 'true' : 'false',
      csvEscape(r.notes ?? ''),
    ].join(','),
  );
  return [header, ...lines].join('\n');
}

// ---------- Routes ----------

// GET /api/tax-tags — list all tags for the household (used by the picker).
router.get('/tax-tags', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const tags = await TaxTag.findAll({
      where: { householdId: household.id },
      order: [['name', 'ASC']],
    });
    res.json({
      data: tags.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
      })),
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/tax-tags — create a new tag. 400 on dupe name within household.
router.post('/tax-tags', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const body = (req.body || {}) as Record<string, unknown>;
    const name = String(body.name ?? '').trim().slice(0, 64);
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const description =
      body.description == null ? null : String(body.description).slice(0, 4000);
    const existing = await TaxTag.findOne({
      where: { householdId: household.id, name },
    });
    if (existing) {
      res.status(409).json({ error: 'A tag with that name already exists.' });
      return;
    }
    const created = await TaxTag.create({
      householdId: household.id,
      name,
      description,
    });
    res.status(201).json({
      data: { id: created.id, name: created.name, description: created.description },
    });
  } catch (e) {
    next(e);
  }
});

// PATCH /api/transactions/:id/tax — set or clear the tax metadata sidecar.
router.patch('/transactions/:id/tax', async (req, res, next) => {
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
    const patch = await validateTaxPatch(req, body);
    if (!patch.ok) {
      res.status(patch.status).json({ error: patch.error });
      return;
    }

    const existing = await TransactionTaxMetadata.findOne({
      where: { transactionId: txn.id },
    });
    if (existing) {
      if ('taxTagId' in patch.value) existing.taxTagId = patch.value.taxTagId ?? null;
      if ('deductiblePercent' in patch.value)
        existing.deductiblePercent = patch.value.deductiblePercent!;
      if ('hstGstAmount' in patch.value)
        existing.hstGstAmount = patch.value.hstGstAmount ?? null;
      if ('receiptRequired' in patch.value)
        existing.receiptRequired = Boolean(patch.value.receiptRequired);
      if ('reviewedForTax' in patch.value)
        existing.reviewedForTax = Boolean(patch.value.reviewedForTax);
      await existing.save();
    } else {
      await TransactionTaxMetadata.create({
        transactionId: txn.id,
        taxTagId: patch.value.taxTagId ?? null,
        deductiblePercent:
          patch.value.deductiblePercent ?? (txn.finalBusiness ? '1.0000' : '0.0000'),
        hstGstAmount: patch.value.hstGstAmount ?? null,
        receiptRequired: Boolean(patch.value.receiptRequired),
        reviewedForTax: Boolean(patch.value.reviewedForTax),
      });
    }

    const reloaded = await TransactionTaxMetadata.findOne({
      where: { transactionId: txn.id },
      include: [{ model: TaxTag, as: 'taxTag', attributes: ['id', 'name'] }],
    });
    res.json({
      data: serializeTaxMetadata(reloaded),
    });
  } catch (e) {
    next(e);
  }
});

interface NormalizedTaxPatch {
  taxTagId?: number | null;
  deductiblePercent?: string;
  hstGstAmount?: string | null;
  receiptRequired?: boolean;
  reviewedForTax?: boolean;
}

type TaxPatchResult =
  | { ok: true; value: NormalizedTaxPatch }
  | { ok: false; status: number; error: string };

export async function validateTaxPatch(
  req: Request,
  raw: Record<string, unknown>,
): Promise<TaxPatchResult> {
  const out: NormalizedTaxPatch = {};
  if ('taxTagId' in raw) {
    if (raw.taxTagId == null || raw.taxTagId === '') {
      out.taxTagId = null;
    } else {
      const id = Number(raw.taxTagId);
      if (!Number.isInteger(id) || id <= 0) {
        return { ok: false, status: 400, error: 'taxTagId must be a positive integer or null' };
      }
      const { household } = currentAuth(req);
      const tag = await TaxTag.findOne({
        where: { id, householdId: household.id },
      });
      if (!tag) {
        return { ok: false, status: 400, error: 'taxTagId does not reference a tag in this household' };
      }
      out.taxTagId = tag.id;
    }
  }
  if ('deductiblePercent' in raw) {
    const v = Number(raw.deductiblePercent);
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      return {
        ok: false,
        status: 400,
        error: 'deductiblePercent must be a number between 0 and 1',
      };
    }
    out.deductiblePercent = v.toFixed(4);
  }
  if ('hstGstAmount' in raw) {
    if (raw.hstGstAmount == null || raw.hstGstAmount === '') {
      out.hstGstAmount = null;
    } else {
      const v = Number(raw.hstGstAmount);
      if (!Number.isFinite(v) || v < 0) {
        return {
          ok: false,
          status: 400,
          error: 'hstGstAmount must be a non-negative number or null',
        };
      }
      out.hstGstAmount = v.toFixed(4);
    }
  }
  if ('receiptRequired' in raw) {
    out.receiptRequired = Boolean(raw.receiptRequired);
  }
  if ('reviewedForTax' in raw) {
    out.reviewedForTax = Boolean(raw.reviewedForTax);
  }
  return { ok: true, value: out };
}

function serializeTaxMetadata(meta: TransactionTaxMetadata | null) {
  if (!meta) {
    return {
      transactionId: null,
      taxTagId: null,
      taxTag: null,
      deductiblePercent: '0.0000',
      hstGstAmount: null,
      receiptRequired: false,
      reviewedForTax: false,
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tag = (meta as any).taxTag as { id: number; name: string } | undefined;
  return {
    transactionId: meta.transactionId,
    taxTagId: meta.taxTagId,
    taxTag: tag ? { id: tag.id, name: tag.name } : null,
    deductiblePercent: String(meta.deductiblePercent),
    hstGstAmount: meta.hstGstAmount == null ? null : String(meta.hstGstAmount),
    receiptRequired: Boolean(meta.receiptRequired),
    reviewedForTax: Boolean(meta.reviewedForTax),
  };
}

// GET /api/business/tax-summary — per-currency rollup (gross / deductible / HST-GST).
router.get('/business/tax-summary', async (req, res, next) => {
  try {
    const where = buildHygieneWhere(req);
    const rows = await Transaction.findAll({
      where,
      attributes: ['id', 'amount', 'currency', 'finalBusiness'],
      include: [
        {
          model: TransactionTaxMetadata,
          as: 'taxMetadata',
          attributes: ['deductiblePercent', 'hstGstAmount', 'reviewedForTax'],
          required: false,
        },
      ],
    });
    const inputRows: TaxSummaryInputRow[] = rows.map((r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const meta = (r as any).taxMetadata as TransactionTaxMetadata | undefined;
      return {
        amount: String(r.amount),
        currency: String(r.currency),
        finalBusiness: Boolean(r.finalBusiness),
        deductiblePercent: meta?.deductiblePercent == null ? null : String(meta.deductiblePercent),
        hstGstAmount: meta?.hstGstAmount == null ? null : String(meta.hstGstAmount),
        reviewedForTax: Boolean(meta?.reviewedForTax),
      };
    });
    res.json({
      data: aggregateTaxSummary(inputRows),
      scope: parseTaxScope(req.query.scope),
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/business/missing-receipts — list business transactions without a receipt.
router.get('/business/missing-receipts', async (req, res, next) => {
  try {
    const where: WhereOptions = {
      ...buildHygieneWhere(req),
      finalBusiness: true,
    };
    const rows = await Transaction.findAll({
      where,
      attributes: ['id', 'date', 'merchantClean', 'amount', 'currency', 'finalCategory'],
      include: [
        {
          model: Receipt,
          as: 'receipts',
          attributes: ['id'],
          required: false,
        },
        {
          model: TransactionTaxMetadata,
          as: 'taxMetadata',
          attributes: ['receiptRequired', 'taxTagId'],
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
      limit: Math.min(500, Math.max(1, Number(req.query.limit) || 100)),
    });
    const missing = rows
      .filter((r) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const receipts = ((r as any).receipts ?? []) as { id: number }[];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const meta = (r as any).taxMetadata as TransactionTaxMetadata | undefined;
        const required = meta?.receiptRequired ?? true; // business transactions default to required
        return required && receipts.length === 0;
      })
      .map((r) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const acc = (r as any).account as { id: number; name: string } | undefined;
        return {
          id: r.id,
          date: r.date,
          merchant: r.merchantClean,
          amount: String(r.amount),
          currency: String(r.currency),
          finalCategory: r.finalCategory,
          accountName: acc?.name ?? null,
        };
      });
    res.json({ data: missing, count: missing.length });
  } catch (e) {
    next(e);
  }
});

// GET /api/business/review-queue — business txns where reviewed_for_tax = false.
router.get('/business/review-queue', async (req, res, next) => {
  try {
    const where = buildHygieneWhere(req);
    const rows = await Transaction.findAll({
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
          model: TransactionTaxMetadata,
          as: 'taxMetadata',
          attributes: ['reviewedForTax', 'taxTagId', 'deductiblePercent'],
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
      limit: Math.min(500, Math.max(1, Number(req.query.limit) || 100)),
    });
    const queue = rows
      .filter((r) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const meta = (r as any).taxMetadata as TransactionTaxMetadata | undefined;
        return !meta || meta.reviewedForTax === false;
      })
      .map((r) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const acc = (r as any).account as { id: number; name: string } | undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const meta = (r as any).taxMetadata as TransactionTaxMetadata | undefined;
        return {
          id: r.id,
          date: r.date,
          merchant: r.merchantClean,
          amount: String(r.amount),
          currency: String(r.currency),
          finalCategory: r.finalCategory,
          finalBusiness: Boolean(r.finalBusiness),
          accountName: acc?.name ?? null,
          taxTagId: meta?.taxTagId ?? null,
          deductiblePercent:
            meta?.deductiblePercent == null
              ? r.finalBusiness
                ? '1.0000'
                : '0.0000'
              : String(meta.deductiblePercent),
        };
      });
    res.json({ data: queue, count: queue.length });
  } catch (e) {
    next(e);
  }
});

// GET /api/exports/tax — tax-ready CSV of in-scope transactions.
router.get('/exports/tax', async (req, res, next) => {
  try {
    const where = buildHygieneWhere(req);
    const rows = await Transaction.findAll({
      where,
      attributes: [
        'id',
        'date',
        'merchantClean',
        'amount',
        'currency',
        'finalCategory',
        'finalBusiness',
        'finalSplitType',
        'notes',
      ],
      include: [
        {
          model: Receipt,
          as: 'receipts',
          attributes: ['id'],
          required: false,
        },
        {
          model: TransactionTaxMetadata,
          as: 'taxMetadata',
          attributes: [
            'deductiblePercent',
            'hstGstAmount',
            'receiptRequired',
            'reviewedForTax',
            'taxTagId',
          ],
          include: [{ model: TaxTag, as: 'taxTag', attributes: ['id', 'name'] }],
          required: false,
        },
        {
          model: Account,
          as: 'account',
          attributes: ['id', 'name'],
          required: false,
        },
      ],
      order: [['date', 'ASC']],
    });
    const exportRows: TaxExportRow[] = rows.map((r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const meta = (r as any).taxMetadata as
        | (TransactionTaxMetadata & { taxTag?: { id: number; name: string } | null })
        | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const receipts = ((r as any).receipts ?? []) as { id: number }[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const acc = (r as any).account as { id: number; name: string } | undefined;
      const declaredDeductible = meta?.deductiblePercent;
      const defaultDeductible = r.finalBusiness ? '1.0000' : '0.0000';
      const deductiblePercent =
        declaredDeductible == null ? defaultDeductible : String(declaredDeductible);
      const amountNum = num(r.amount) ?? 0;
      const deductibleAmount = (Math.max(0, -amountNum) * Number(deductiblePercent)).toFixed(2);
      return {
        id: r.id,
        date: r.date,
        merchant: r.merchantClean,
        accountName: acc?.name ?? null,
        currency: String(r.currency),
        amount: String(r.amount),
        finalCategory: r.finalCategory,
        finalBusiness: Boolean(r.finalBusiness),
        finalSplitType: String(r.finalSplitType),
        taxTagName: meta?.taxTag?.name ?? null,
        deductiblePercent,
        deductibleAmount,
        hstGstAmount: meta?.hstGstAmount == null ? null : String(meta.hstGstAmount),
        receiptRequired: meta?.receiptRequired ?? Boolean(r.finalBusiness),
        hasReceipt: receipts.length > 0,
        reviewedForTax: Boolean(meta?.reviewedForTax),
        notes: r.notes,
      };
    });
    const csv = rowsToTaxCsv(exportRows);
    const today = new Date().toISOString().slice(0, 10);
    const scope = parseTaxScope(req.query.scope);
    const filename = `tax-${scope}-${today}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (e) {
    next(e);
  }
});

export default router;
