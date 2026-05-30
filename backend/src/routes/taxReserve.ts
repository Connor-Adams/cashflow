/**
 * Tax reserve calculator endpoints (issue #223).
 *
 * Estimates how much cash a household should set aside per currency for an
 * upcoming tax bill, given the period's business income, deductible
 * business expenses, and any HST/GST collected on top. This is planning
 * support, NOT tax filing advice — the disclaimer is also surfaced in the
 * UI so the user is never confused about what the number represents.
 *
 * Endpoints:
 * - GET    /api/tax/reserve/settings       — list per-currency settings (synth defaults).
 * - PUT    /api/tax/reserve/settings/:currency — upsert one currency's row.
 * - DELETE /api/tax/reserve/settings/:currency — delete one currency's row.
 * - GET    /api/tax/reserve/summary?scope&from&to&periodicity — per-period rollup.
 *
 * The pure helpers (`composeTaxReserve`, `bucketByPeriod`, `aggregateReserveRows`)
 * are exported for unit tests in test/taxReserve.test.ts.
 */
import { Router } from 'express';
import { type WhereOptions } from 'sequelize';
import {
  Transaction,
  TransactionTaxMetadata,
  TaxReserveSetting,
} from '../models';
import { DEFAULT_TAX_RESERVE_PERCENT } from '../models/TaxReserveSetting';
import { currentAuth } from '../auth/middleware';
import { visibleTransactionWhere } from '../auth/scope';
import { num } from '../util/numbers';
import { parseTaxScope, scopeWhere, dateRangeWhere } from './businessTax';

const router = Router();

// ---------- Period bucketing --------------------------------------------

export type Periodicity = 'monthly' | 'quarterly' | 'annual';
const PERIODICITIES: readonly Periodicity[] = ['monthly', 'quarterly', 'annual'] as const;

export function parsePeriodicity(
  raw: unknown,
  fallback: Periodicity = 'quarterly',
): Periodicity {
  const s = String(raw ?? '').toLowerCase();
  return (PERIODICITIES as readonly string[]).includes(s)
    ? (s as Periodicity)
    : fallback;
}

/**
 * Maps a YYYY-MM-DD date to its period key for the given periodicity.
 * - monthly:   2026-03-15 → 2026-03
 * - quarterly: 2026-04-15 → 2026-Q2
 * - annual:    2026-12-31 → 2026
 *
 * Inputs not parsing as ISO dates fall back to the raw string, so a
 * malformed row is at least surfaced rather than silently dropped.
 */
export function periodKey(dateStr: string, periodicity: Periodicity): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return dateStr;
  const year = m[1];
  const month = Number(m[2]);
  if (periodicity === 'monthly') return `${year}-${String(month).padStart(2, '0')}`;
  if (periodicity === 'annual') return year;
  // quarterly
  const q = Math.floor((month - 1) / 3) + 1;
  return `${year}-Q${q}`;
}

// ---------- Pure aggregator + reserve calc ------------------------------

export interface ReserveInputRow {
  /** YYYY-MM-DD */
  date: string;
  /** Transaction.amount as DECIMAL string. Charges are NEGATIVE, income POSITIVE. */
  amount: string;
  currency: string;
  finalBusiness: boolean;
  /** From TransactionTaxMetadata.deductiblePercent ([0,1]). Null when no metadata. */
  deductiblePercent: string | null;
  /** From TransactionTaxMetadata.hstGstAmount. Null when not classified. */
  hstGstAmount: string | null;
}

export interface ReserveComponents {
  /** Sum of business income for the period+currency (positive amounts). */
  businessIncome: number;
  /** Sum of |amount| * deductiblePercent for business expenses (negative amounts). */
  deductibleExpenses: number;
  /** Sum of hstGstAmount on income rows (positive amounts where HST/GST collected). */
  hstGstCollected: number;
  /** Sum of hstGstAmount on expense rows (input tax credits / ITC). */
  hstGstPaid: number;
}

export interface ReserveRollup {
  currency: string;
  period: string;
  components: ReserveComponents;
  /**
   * Net business income after deductible expenses. `businessIncome -
   * deductibleExpenses`. May be negative when expenses exceed income.
   */
  netBusinessIncome: number;
  /** Net HST/GST owed (collected - paid). May be negative if ITC > collected. */
  netHstGst: number;
  /** Reserve percent applied (from settings or default). Fraction in [0, 1]. */
  reservePercent: number;
  /**
   * Suggested reserve target = max(0, netBusinessIncome) * reservePercent +
   * max(0, netHstGst). Clipped at zero so loss periods don't suggest a
   * negative reserve, but HST/GST is always remitted gross of income.
   */
  reserveTarget: number;
}

/**
 * Builds one rollup per (period, currency). Reserve percent is looked up
 * per-currency via the passed `reservePercents` map; missing currencies
 * fall back to `defaultPercent`.
 */
export function aggregateReserveRollups(
  rows: ReserveInputRow[],
  periodicity: Periodicity,
  reservePercents: Map<string, number>,
  defaultPercent: number,
): ReserveRollup[] {
  type Bucket = {
    currency: string;
    period: string;
    components: ReserveComponents;
  };
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    const period = periodKey(row.date, periodicity);
    const key = `${row.currency}|${period}`;
    const bucket = buckets.get(key) ?? {
      currency: row.currency,
      period,
      components: {
        businessIncome: 0,
        deductibleExpenses: 0,
        hstGstCollected: 0,
        hstGstPaid: 0,
      },
    };
    const amount = num(row.amount) ?? 0;
    const hstGst = num(row.hstGstAmount) ?? 0;
    if (row.finalBusiness) {
      if (amount > 0) {
        bucket.components.businessIncome += amount;
        bucket.components.hstGstCollected += hstGst;
      } else if (amount < 0) {
        const declaredDeductible = num(row.deductiblePercent);
        const deductiblePct = declaredDeductible != null ? declaredDeductible : 1;
        bucket.components.deductibleExpenses += -amount * deductiblePct;
        bucket.components.hstGstPaid += hstGst;
      }
    }
    buckets.set(key, bucket);
  }
  const out: ReserveRollup[] = [];
  for (const bucket of buckets.values()) {
    const reservePercent =
      reservePercents.get(bucket.currency) ?? defaultPercent;
    const netBusinessIncome =
      bucket.components.businessIncome - bucket.components.deductibleExpenses;
    const netHstGst =
      bucket.components.hstGstCollected - bucket.components.hstGstPaid;
    const reserveTarget = round2(
      Math.max(0, netBusinessIncome) * reservePercent + Math.max(0, netHstGst),
    );
    out.push({
      currency: bucket.currency,
      period: bucket.period,
      components: {
        businessIncome: round2(bucket.components.businessIncome),
        deductibleExpenses: round2(bucket.components.deductibleExpenses),
        hstGstCollected: round2(bucket.components.hstGstCollected),
        hstGstPaid: round2(bucket.components.hstGstPaid),
      },
      netBusinessIncome: round2(netBusinessIncome),
      netHstGst: round2(netHstGst),
      reservePercent,
      reserveTarget,
    });
  }
  // Sort: currency asc, period asc (lexicographically — works for YYYY-MM,
  // YYYY-Qn, YYYY because each form sorts by year first).
  out.sort((a, b) => {
    if (a.currency !== b.currency) return a.currency.localeCompare(b.currency);
    return a.period.localeCompare(b.period);
  });
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pure single-period reserve calc — exposed so the dashboard tile and the
 * AI summarizer can reuse the same math without re-aggregating from raw
 * transactions. Mirrors the formula used by aggregateReserveRollups but
 * takes pre-aggregated totals.
 */
export function composeTaxReserve(input: {
  businessIncome: number;
  deductibleExpenses: number;
  hstGstCollected: number;
  hstGstPaid: number;
  reservePercent: number;
}): {
  netBusinessIncome: number;
  netHstGst: number;
  reserveTarget: number;
} {
  const netBusinessIncome = input.businessIncome - input.deductibleExpenses;
  const netHstGst = input.hstGstCollected - input.hstGstPaid;
  const reserveTarget = round2(
    Math.max(0, netBusinessIncome) * input.reservePercent +
      Math.max(0, netHstGst),
  );
  return {
    netBusinessIncome: round2(netBusinessIncome),
    netHstGst: round2(netHstGst),
    reserveTarget,
  };
}

// ---------- Settings serializer + validator ------------------------------

export interface ReserveSettingDto {
  currency: string;
  reservePercent: string;
  note: string | null;
  /** True when this row is synthesised from defaults (no DB row yet). */
  isDefault: boolean;
}

function serializeSetting(row: TaxReserveSetting): ReserveSettingDto {
  return {
    currency: row.currency,
    reservePercent: String(row.reservePercent),
    note: row.note,
    isDefault: false,
  };
}

function defaultSetting(currency: string): ReserveSettingDto {
  return {
    currency,
    reservePercent: DEFAULT_TAX_RESERVE_PERCENT,
    note: null,
    isDefault: true,
  };
}

interface ReservePatch {
  reservePercent?: string;
  note?: string | null;
}

export function validateReservePatch(
  raw: Record<string, unknown>,
): { ok: true; patch: ReservePatch } | { ok: false; error: string } {
  const out: ReservePatch = {};
  if ('reservePercent' in raw) {
    const v = Number(raw.reservePercent);
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      return {
        ok: false,
        error: 'reservePercent must be a number between 0 and 1',
      };
    }
    out.reservePercent = v.toFixed(4);
  }
  if ('note' in raw) {
    if (raw.note == null || raw.note === '') {
      out.note = null;
    } else {
      out.note = String(raw.note).slice(0, 4000);
    }
  }
  return { ok: true, patch: out };
}

function isValidCurrency(raw: string): boolean {
  return /^[A-Z]{3}$/.test(raw);
}

// ---------- Routes -------------------------------------------------------

/**
 * GET /api/tax/reserve/settings
 *
 * Returns every TaxReserveSetting row for the household plus a synthesised
 * default row for each currency present in the household's transactions
 * that doesn't already have a row. The synthesised rows are flagged
 * `isDefault: true` so the UI can render them as "implicit".
 */
router.get('/settings', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const rows = await TaxReserveSetting.findAll({
      where: { householdId: household.id },
      order: [['currency', 'ASC']],
    });
    const explicit = new Map(rows.map((r) => [r.currency, serializeSetting(r)]));
    // Synth defaults for any currency the household has business transactions in.
    const observed = await Transaction.findAll({
      where: {
        ...visibleTransactionWhere(req),
        finalBusiness: true,
      },
      attributes: ['currency'],
      group: ['currency'],
      raw: true,
    });
    const observedCurrencies = new Set(
      observed.map((r: unknown) => (r as { currency: string }).currency),
    );
    for (const c of observedCurrencies) {
      if (!explicit.has(c)) explicit.set(c, defaultSetting(c));
    }
    const data = Array.from(explicit.values()).sort((a, b) =>
      a.currency.localeCompare(b.currency),
    );
    res.json({ data });
  } catch (e) {
    next(e);
  }
});

/**
 * PUT /api/tax/reserve/settings/:currency
 *
 * Upserts one row keyed by (household, currency). 400 on invalid percent
 * or currency code. Returns the freshly written row.
 */
router.put('/settings/:currency', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const currency = String(req.params.currency).toUpperCase();
    if (!isValidCurrency(currency)) {
      res.status(400).json({ error: 'currency must be a 3-letter ISO code' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = validateReservePatch(body);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    const [row] = await TaxReserveSetting.findOrCreate({
      where: { householdId: household.id, currency },
      defaults: {
        householdId: household.id,
        currency,
        reservePercent: DEFAULT_TAX_RESERVE_PERCENT,
      },
    });
    if (result.patch.reservePercent !== undefined) {
      row.set('reservePercent', result.patch.reservePercent);
    }
    if (result.patch.note !== undefined) {
      row.set('note', result.patch.note);
    }
    await row.save();
    res.json({ data: serializeSetting(row) });
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /api/tax/reserve/settings/:currency
 *
 * Removes the row so the household reverts to the synthesised default for
 * that currency. 204 on success even when no row existed (idempotent).
 */
router.delete('/settings/:currency', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const currency = String(req.params.currency).toUpperCase();
    if (!isValidCurrency(currency)) {
      res.status(400).json({ error: 'currency must be a 3-letter ISO code' });
      return;
    }
    await TaxReserveSetting.destroy({
      where: { householdId: household.id, currency },
    });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/tax/reserve/summary
 *
 * Period rollup of business income, deductible expenses, HST/GST collected
 * and paid, plus suggested reserve target per (period, currency). Reserve
 * percent comes from the household's tax_reserve_settings (or the default
 * fallback) per currency.
 *
 * Query params:
 * - scope:       personal|shared|business|all (default business — matches
 *                businessTax). Reserve is only computed for `finalBusiness`
 *                rows, so non-business scopes return an empty summary.
 * - from / to:   YYYY-MM-DD inclusive date filter.
 * - periodicity: monthly|quarterly|annual (default quarterly).
 */
router.get('/summary', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const scope = parseTaxScope(req.query.scope);
    const periodicity = parsePeriodicity(req.query.periodicity);
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const where: WhereOptions = {
      ...visibleTransactionWhere(req),
      ...scopeWhere(scope),
      ...dateRangeWhere(from, to),
    };
    const rows = await Transaction.findAll({
      where,
      attributes: ['id', 'date', 'amount', 'currency', 'finalBusiness'],
      include: [
        {
          model: TransactionTaxMetadata,
          as: 'taxMetadata',
          attributes: ['deductiblePercent', 'hstGstAmount'],
          required: false,
        },
      ],
    });
    const inputRows: ReserveInputRow[] = rows.map((r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const meta = (r as any).taxMetadata as TransactionTaxMetadata | undefined;
      return {
        date: String(r.date),
        amount: String(r.amount),
        currency: String(r.currency),
        finalBusiness: Boolean(r.finalBusiness),
        deductiblePercent:
          meta?.deductiblePercent == null ? null : String(meta.deductiblePercent),
        hstGstAmount:
          meta?.hstGstAmount == null ? null : String(meta.hstGstAmount),
      };
    });
    // Build per-currency percent lookup from settings.
    const settings = await TaxReserveSetting.findAll({
      where: { householdId: household.id },
    });
    const reservePercents = new Map<string, number>();
    for (const s of settings) {
      const v = Number(s.reservePercent);
      if (Number.isFinite(v)) reservePercents.set(s.currency, v);
    }
    const defaultPercent = Number(DEFAULT_TAX_RESERVE_PERCENT);
    const rollups = aggregateReserveRollups(
      inputRows,
      periodicity,
      reservePercents,
      defaultPercent,
    );
    res.json({
      data: rollups,
      scope,
      periodicity,
      disclaimer:
        'Planning support only. Not tax filing advice. Confirm with your accountant.',
    });
  } catch (e) {
    next(e);
  }
});

export default router;
