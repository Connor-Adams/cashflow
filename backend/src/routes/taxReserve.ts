/**
 * Tax reserve calculator endpoints (issue #223).
 *
 * Estimates how much cash a household should set aside for an upcoming tax
 * bill, given the period's business income, deductible business expenses,
 * and any HST/GST collected on top. This is planning support, NOT tax filing
 * advice — the disclaimer is also surfaced in the UI so the user is never
 * confused about what the number represents.
 *
 * The reserve is ONE figure in CAD. Canadian tax is assessed and paid in CAD,
 * and USD client income is converted to CAD almost as soon as it lands, so
 * every business row is converted at its own transaction date (fx/toCad.ts,
 * the same path the T2 builder uses) before it is bucketed. Bucketing per
 * currency reserved 25% of gross USD income while CAD expenses sat unused in
 * a separate loss bucket. A conversion made on a substituted rate (stale or
 * post-dated) is returned as a warning, as the tax facts do (#1190).
 *
 * Endpoints:
 * - GET    /api/tax/reserve/settings          — the household's CAD reserve setting.
 * - PUT    /api/tax/reserve/settings/:currency — upsert it (CAD only).
 * - DELETE /api/tax/reserve/settings/:currency — delete a row (any currency, so
 *                                               legacy non-CAD rows can be cleared).
 * - GET    /api/tax/reserve/summary?scope&from&to&periodicity — per-period CAD rollup.
 *
 * The pure helpers (`composeTaxReserve`, `parsePeriodicity`, `periodKey`,
 * `convertReserveRowsToCad`, `aggregateReserveRollups`, `validateReservePatch`)
 * are exported; reporting.ts reuses `composeTaxReserve`, `loadReserveRollups`
 * and `loadCadReservePercent`.
 */
import { Router } from 'express';
import { type WhereOptions } from 'sequelize';
import {
  Account,
  Transaction,
  TransactionTaxMetadata,
  TaxReserveSetting,
} from '../models';
import { DEFAULT_TAX_RESERVE_PERCENT } from '../models/TaxReserveSetting';
import { currentAuth } from '../auth/middleware';
import { visibleTransactionWhere } from '../auth/scope';
import { num } from '../util/numbers';
import { resolveDeductiblePercent } from '../tax/util/deductiblePercent';
import { parseTaxScope, scopeWhere, dateRangeWhere } from './businessTax';
import {
  classifyPositiveAmount,
  isNonSpend,
} from '../summary/classifyTransactionFlow';
import {
  loadItemAllocationContext,
  type ItemAllocationContext,
} from '../summary/loadItemAllocations';
import { splitTxnByItems } from '../import/splitTxnByItems';
import { toCad, type ToCadResult } from '../fx/toCad';
import { createFxFallbackCollector } from '../fx/fxFallbackWarnings';
import { D, type Decimal } from '../tax/util/decimal';

/** The reserve's only currency. */
export const RESERVE_CURRENCY = 'CAD';

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
  /** Currency of `amount`. 'CAD' once convertReserveRowsToCad has run. */
  currency: string;
  /** The row's original currency, kept after conversion. Absent → `currency`. */
  sourceCurrency?: string;
  finalBusiness: boolean;
  /** From TransactionTaxMetadata.deductiblePercent ([0,1]). Null when no metadata. */
  deductiblePercent: string | null;
  /** From TransactionTaxMetadata.hstGstAmount. Null when not classified. */
  hstGstAmount: string | null;
  /**
   * The business portion of `amount` (same sign), as the dashboard's business
   * tile counts it: Transaction.businessAmount, or for an itemized txn the sum
   * of its item allocations (splitTxnByItems), so an order whose items are
   * only partly business deducts only that part. Absent → the full `amount`.
   */
  businessAmount?: string | null;
  /**
   * Transaction.txnType, the owning account's type, and the merchant/category
   * text. These feed the dashboard headline's classifier
   * (summary/classifyTransactionFlow.ts) so only `txnType='income'` rows count
   * as business income. Absent → treated as unsignaled.
   */
  txnType?: string | null;
  accountType?: string | null;
  merchantRaw?: string | null;
  merchantClean?: string | null;
  finalCategory?: string | null;
}

export interface ReserveComponents {
  /** Sum of business income for the period+currency (positive `txnType='income'` rows). */
  businessIncome: number;
  /**
   * Sum of |businessAmount| * deductiblePercent for business expenses
   * (negative spend rows), less the same for business refunds/credits, which
   * net against it. Only the business portion of a partly-business row counts.
   */
  deductibleExpenses: number;
  /** Sum of hstGstAmount on income rows (positive amounts where HST/GST collected). */
  hstGstCollected: number;
  /**
   * Sum of hstGstAmount on expense rows (input tax credits / ITC), less
   * refunded HST/GST — each scaled by the row's business share, since only
   * the business-use portion of the tax is claimable.
   */
  hstGstPaid: number;
}

export interface ReserveRollup {
  /** Always 'CAD' — kept on each row for backward compatibility. */
  currency: string;
  period: string;
  /** Original currencies of the rows in this period (sorted), e.g. ['CAD', 'USD']. */
  sourceCurrencies: string[];
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
 * Route one business row into the reserve, using the same classification as
 * the dashboard headline (summary/classifyTransactionFlow.ts):
 *
 *   - negative + `isNonSpend` (payment/transfer legs, brokerage flows, any row
 *     on an investment account, …) → 'skip'; otherwise → 'expense'.
 *   - positive → `classifyPositiveAmount`: a 'credit' with `txnType='income'`
 *     is 'income'; any other 'credit' (refund, reward, refund-text fallback)
 *     is a 'refund' that nets against expenses; 'payment' and 'skip'
 *     (untyped deposits, transfers) contribute nothing.
 *
 * businessTax.ts documents that positive business rows are mostly refunds,
 * transfers and payments — treating every one as revenue overstated the
 * reserve.
 */
function classifyReserveFlow(
  row: ReserveInputRow,
  amount: number,
): 'income' | 'expense' | 'refund' | 'skip' {
  if (amount < 0) {
    return isNonSpend(row.txnType, row.accountType) ? 'skip' : 'expense';
  }
  if (amount === 0) return 'skip';
  const bucket = classifyPositiveAmount({
    txnType: row.txnType,
    accountType: row.accountType,
    merchantRaw: row.merchantRaw,
    merchantClean: row.merchantClean,
    category: row.finalCategory,
  });
  if (bucket !== 'credit') return 'skip';
  return row.txnType === 'income' ? 'income' : 'refund';
}

/**
 * Fraction (0..1) of a non-zero `amount` that is business. Absent
 * `businessAmount` means the whole row; clamped like splitTxnByItems'
 * txn-level business fraction.
 */
function businessShare(row: ReserveInputRow, amount: number): number {
  const business = num(row.businessAmount);
  if (business == null) return 1;
  const ratio = business / amount;
  return Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 0;
}

export type CadConverter = (
  amount: Decimal,
  currency: string,
  date: string,
) => Promise<ToCadResult>;

/**
 * Converts each row to CAD at its own transaction date via `convert`
 * (fx/toCad in production). `amount`, `businessAmount` and `hstGstAmount` all
 * use that date's rate; the row keeps its original currency in
 * `sourceCurrency`. One rate lookup per (currency, date).
 *
 * Conversions made on a substituted rate (toCad's `fallback_nearest`, or a
 * post-dated `fallback_any`) become warnings. A currency with no rate on file
 * at all is left out — its rows cannot be expressed in CAD — and named in a
 * warning rather than failing the whole reserve.
 */
export async function convertReserveRowsToCad(
  rows: ReserveInputRow[],
  convert: CadConverter = toCad,
): Promise<{ rows: ReserveInputRow[]; warnings: string[] }> {
  const fallbacks = createFxFallbackCollector();
  const rates = new Map<string, Promise<Decimal | null>>();
  const unconvertible = new Map<string, number>();
  const rateFor = (currency: string, date: string): Promise<Decimal | null> => {
    const key = `${currency}|${date}`;
    let pending = rates.get(key);
    if (!pending) {
      pending = convert(D(1), currency, date).then(
        (result) => {
          fallbacks.record(currency, date, result);
          return result.cad;
        },
        () => null,
      );
      rates.set(key, pending);
    }
    return pending;
  };
  const scale = (value: string, rate: Decimal): string =>
    num(value) == null ? value : D(value).times(rate).toString();

  const out: ReserveInputRow[] = [];
  for (const row of rows) {
    const currency = row.currency || RESERVE_CURRENCY;
    if (currency === RESERVE_CURRENCY) {
      out.push({ ...row, currency, sourceCurrency: row.sourceCurrency ?? currency });
      continue;
    }
    const rate = await rateFor(currency, row.date);
    if (rate == null) {
      unconvertible.set(currency, (unconvertible.get(currency) ?? 0) + 1);
      continue;
    }
    out.push({
      ...row,
      currency: RESERVE_CURRENCY,
      sourceCurrency: currency,
      amount: scale(row.amount, rate),
      businessAmount: row.businessAmount == null ? row.businessAmount : scale(row.businessAmount, rate),
      hstGstAmount: row.hstGstAmount == null ? null : scale(row.hstGstAmount, rate),
    });
  }
  const warnings = fallbacks.warnings();
  for (const [currency, count] of [...unconvertible].sort()) {
    warnings.push(
      `No ${currency}→CAD exchange rate is on file at all, so ${count} business transaction(s) `
      + `in ${currency} were left out of the reserve. Add the rate and recompute.`,
    );
  }
  return { rows: out, warnings };
}

/**
 * Builds one CAD rollup per period at the household's single reserve
 * percent. Rows must already be in CAD (convertReserveRowsToCad): a non-CAD
 * row throws rather than being summed into a CAD bucket.
 */
export function aggregateReserveRollups(
  rows: ReserveInputRow[],
  periodicity: Periodicity,
  reservePercent: number,
): ReserveRollup[] {
  type Bucket = {
    period: string;
    sourceCurrencies: Set<string>;
    components: ReserveComponents;
  };
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    if (row.currency !== RESERVE_CURRENCY) {
      throw new Error(
        `aggregateReserveRollups: ${row.currency} row on ${row.date}; convert rows to CAD first`,
      );
    }
    const period = periodKey(row.date, periodicity);
    const bucket = buckets.get(period) ?? {
      period,
      sourceCurrencies: new Set<string>(),
      components: {
        businessIncome: 0,
        deductibleExpenses: 0,
        hstGstCollected: 0,
        hstGstPaid: 0,
      },
    };
    bucket.sourceCurrencies.add(row.sourceCurrency ?? row.currency);
    const amount = num(row.amount) ?? 0;
    const hstGst = num(row.hstGstAmount) ?? 0;
    if (row.finalBusiness) {
      const flow = classifyReserveFlow(row, amount);
      if (flow === 'income') {
        bucket.components.businessIncome += amount;
        bucket.components.hstGstCollected += hstGst;
      } else if (flow === 'expense' || flow === 'refund') {
        // A refund is a negative expense: it nets the deductible amount and
        // the input tax credit back down rather than counting as revenue.
        // Only the business share of the row is deductible, and only that
        // share of its HST/GST is an input tax credit.
        const share = businessShare(row, amount);
        const deductiblePct = resolveDeductiblePercent(row.deductiblePercent, true);
        bucket.components.deductibleExpenses += -amount * share * deductiblePct;
        const itc = hstGst * share;
        bucket.components.hstGstPaid += flow === 'refund' ? -itc : itc;
      }
    }
    buckets.set(period, bucket);
  }
  const out: ReserveRollup[] = [];
  for (const bucket of buckets.values()) {
    const c = bucket.components;
    out.push({
      currency: RESERVE_CURRENCY,
      period: bucket.period,
      sourceCurrencies: [...bucket.sourceCurrencies].sort(),
      components: {
        businessIncome: round2(c.businessIncome),
        deductibleExpenses: round2(c.deductibleExpenses),
        hstGstCollected: round2(c.hstGstCollected),
        hstGstPaid: round2(c.hstGstPaid),
      },
      ...composeTaxReserve({ ...c, reservePercent }),
      reservePercent,
    });
  }
  // Lexicographic sort works for YYYY-MM, YYYY-Qn and YYYY (year first).
  out.sort((a, b) => a.period.localeCompare(b.period));
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pure single-period reserve calc over pre-aggregated CAD totals: the one
 * formula, applied per period by aggregateReserveRollups and over a whole
 * window by the /api/v1 reporting routes (reporting.ts).
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
 * The household's reserve percent: its CAD row, else the default. Rows for
 * other currencies predate the single-CAD reserve and are not consulted.
 */
export async function loadCadReservePercent(householdId: number): Promise<number> {
  const row = await TaxReserveSetting.findOne({
    where: { householdId, currency: RESERVE_CURRENCY },
  });
  const v = row ? Number(row.reservePercent) : NaN;
  return Number.isFinite(v) ? v : Number(DEFAULT_TAX_RESERVE_PERCENT);
}

/**
 * GET /api/tax/reserve/settings
 *
 * `data` is a one-element list: the household's CAD setting, or a synthesised
 * default flagged `isDefault: true`. The list shape is kept for backward
 * compatibility with the per-currency API. Explicit rows for other currencies
 * no longer affect the reserve (every row is converted to CAD); they are
 * returned under `ignored` so they can be seen and deleted.
 */
router.get('/settings', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const rows = await TaxReserveSetting.findAll({
      where: { householdId: household.id },
      order: [['currency', 'ASC']],
    });
    const cad = rows.find((r) => r.currency === RESERVE_CURRENCY);
    res.json({
      data: [cad ? serializeSetting(cad) : defaultSetting(RESERVE_CURRENCY)],
      currency: RESERVE_CURRENCY,
      ignored: rows.filter((r) => r.currency !== RESERVE_CURRENCY).map(serializeSetting),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * PUT /api/tax/reserve/settings/:currency
 *
 * Upserts the household's CAD row. 400 on an invalid percent or currency
 * code, and on any currency other than CAD — a non-CAD percent would be
 * stored and never applied. Returns the freshly written row.
 */
router.put('/settings/:currency', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const currency = String(req.params.currency).toUpperCase();
    if (!isValidCurrency(currency)) {
      res.status(400).json({ error: 'currency must be a 3-letter ISO code' });
      return;
    }
    if (currency !== RESERVE_CURRENCY) {
      res.status(400).json({
        error: 'The tax reserve is computed in CAD (every transaction is converted at its date); only the CAD reserve percent can be set',
      });
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
 * Removes the row: for CAD the household reverts to the default percent; any
 * other currency is a legacy row being cleared. 204 on success even when no
 * row existed (idempotent).
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
 * The business portion of a transaction exactly as the dashboard's business
 * tile computes it (aggregateDashboard → splitTxnByItems): accepted-linked
 * order items carry their own business-use percent, falling back to the
 * txn-level businessAmount; an un-itemized txn is just its businessAmount.
 */
function businessPortion(txn: Transaction, ctx: ItemAllocationContext): number {
  const allocations = splitTxnByItems({
    txn: {
      id: txn.id,
      amount: String(txn.amount),
      currency: txn.currency,
      finalCategory: txn.finalCategory ?? null,
      finalCategoryId: txn.finalCategoryId ?? null,
      finalBusiness: Boolean(txn.finalBusiness),
      finalSplitType: txn.finalSplitType,
      businessAmount: String(txn.businessAmount ?? '0'),
    },
    links: ctx.linksByTxn.get(txn.id) ?? [],
    ordersById: ctx.ordersById,
    itemsByOrder: ctx.itemsByOrder,
  });
  return allocations.reduce((sum, a) => sum + a.businessAmount, 0);
}

export interface ReserveLoadResult {
  /** One CAD rollup per period. */
  rollups: ReserveRollup[];
  /** The household's CAD reserve percent (or the default) applied to every period. */
  reservePercent: number;
  /** FX fallbacks and unconvertible currencies; see convertReserveRowsToCad. */
  warnings: string[];
}

/**
 * Load business transactions matching `where` (+ their tax metadata),
 * convert them to CAD at their own dates, and roll them up at the household's
 * CAD reserve percent. The single source of the reserve number: GET /summary
 * below and the /api/v1 reporting routes both call this, so they can never
 * drift apart.
 */
export async function loadReserveRollups(
  householdId: number,
  where: WhereOptions,
  periodicity: Periodicity,
  convert: CadConverter = toCad,
): Promise<ReserveLoadResult> {
  const rows = await Transaction.findAll({
    where,
    attributes: [
      'id',
      'date',
      'amount',
      'businessAmount',
      'currency',
      'finalBusiness',
      'finalSplitType',
      'txnType',
      'merchantRaw',
      'merchantClean',
      'finalCategory',
      'finalCategoryId',
    ],
    include: [
      {
        model: TransactionTaxMetadata,
        as: 'taxMetadata',
        attributes: ['deductiblePercent', 'hstGstAmount'],
        required: false,
      },
      {
        model: Account,
        as: 'account',
        attributes: ['accountType'],
        required: false,
      },
    ],
  });
  const itemContext = await loadItemAllocationContext(rows.map((r) => r.id));
  const inputRows: ReserveInputRow[] = rows.map((r) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (r as any).taxMetadata as TransactionTaxMetadata | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const account = (r as any).account as { accountType: string | null } | undefined;
    return {
      date: String(r.date),
      amount: String(r.amount),
      currency: String(r.currency),
      finalBusiness: Boolean(r.finalBusiness),
      deductiblePercent:
        meta?.deductiblePercent == null ? null : String(meta.deductiblePercent),
      hstGstAmount:
        meta?.hstGstAmount == null ? null : String(meta.hstGstAmount),
      businessAmount: String(businessPortion(r, itemContext)),
      txnType: r.txnType ?? null,
      accountType: account?.accountType ?? null,
      merchantRaw: r.merchantRaw ?? null,
      merchantClean: r.merchantClean ?? null,
      finalCategory: r.finalCategory ?? null,
    };
  });
  // Only business rows reach the reserve, so only they are converted (a
  // personal row in a wide scope must not trigger an FX lookup).
  const converted = await convertReserveRowsToCad(
    inputRows.filter((r) => r.finalBusiness),
    convert,
  );
  const reservePercent = await loadCadReservePercent(householdId);
  return {
    rollups: aggregateReserveRollups(converted.rows, periodicity, reservePercent),
    reservePercent,
    warnings: converted.warnings,
  };
}

/**
 * GET /api/tax/reserve/summary
 *
 * Period rollup, in CAD, of business income, deductible expenses, HST/GST
 * collected and paid, plus the suggested reserve target per period. Every row
 * is converted to CAD at its transaction date; `warnings` lists conversions
 * made on a substituted (stale or post-dated) rate and any currency left out
 * for want of a rate. Reserve percent is the household's CAD setting (or the
 * default).
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
    const { rollups, reservePercent, warnings } = await loadReserveRollups(
      household.id,
      where,
      periodicity,
    );
    res.json({
      data: rollups,
      currency: RESERVE_CURRENCY,
      reservePercent,
      warnings,
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
