/**
 * FX / currency intelligence routes (issue #221).
 *
 *   GET /api/fx/exposure
 *     Per-currency exposure summary across visible transactions, optionally
 *     filtered by date range. Normalized to a reporting currency.
 *
 *   GET /api/fx/fees
 *     List of transactions flagged as likely FX/conversion fees by the
 *     `detectFxFee` heuristic.
 *
 *   GET /api/fx/effective-rates
 *     Transactions in non-base currencies with an effective rate derivable
 *     from same-date opposite-sign pairs or explicit linked transactions.
 *
 *   GET /api/fx/reporting
 *     Per-metric totals (totalSpend, totalCredits, netSpend) summed across
 *     all visible transactions and normalized to a reporting currency.
 *     Companion to /api/summary/dashboard which returns per-currency
 *     breakdowns; this gives a single normalized number per metric.
 */

import { Router, type Request } from 'express';
import { Op } from 'sequelize';
import { Account, Transaction } from '../models';
import { visibleAccountWhere, visibleTransactionWhere } from '../auth/scope';
import { num } from '../util/numbers';
import { computeCurrencyExposure } from '../fx/currencyExposure';
import {
  detectFxFee,
  type DetectFxFeeInput,
} from '../fx/detectFxFee';
import {
  deriveEffectiveRate,
  type RateDerivationTxn,
} from '../fx/effectiveFxRate';
import {
  normalizeToReportingCurrency,
  type ReportingAggregate,
} from '../fx/reportingNormalization';
import { looseHistoricalFxLookup } from '../networth/aggregate';
import { withCadCrossRates } from '../fx/crossCurrencyFxLookup';

const router = Router();

// looseHistoricalFxLookup only resolves X→CAD (the FxRate table carries only
// CAD-cross series). These routes accept any reportingCurrency, so wrap it to
// derive CAD→X (inverse) and X→Y (chained via CAD) pairs.
const reportingFxLookup = withCadCrossRates(looseHistoricalFxLookup);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const DEFAULT_REPORTING_CURRENCY = 'CAD';
const MAX_FEE_RESULTS = 500;
const MAX_EFFECTIVE_RATE_RESULTS = 500;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseDateRange(req: Request): {
  dateFrom?: string;
  dateTo?: string;
  errors: string[];
} {
  const errors: string[] = [];
  const from = req.query.dateFrom ? String(req.query.dateFrom) : undefined;
  const to = req.query.dateTo ? String(req.query.dateTo) : undefined;
  if (from && !DATE_RE.test(from)) errors.push('dateFrom must be YYYY-MM-DD');
  if (to && !DATE_RE.test(to)) errors.push('dateTo must be YYYY-MM-DD');
  return { dateFrom: from, dateTo: to, errors };
}

function parseReportingCurrency(req: Request): {
  reportingCurrency: string;
  error: string | null;
} {
  const raw = (req.query.reportingCurrency as string | undefined)?.toUpperCase();
  if (!raw) return { reportingCurrency: DEFAULT_REPORTING_CURRENCY, error: null };
  if (!CURRENCY_RE.test(raw)) {
    return {
      reportingCurrency: DEFAULT_REPORTING_CURRENCY,
      error: 'reportingCurrency must be an ISO-3 currency code',
    };
  }
  return { reportingCurrency: raw, error: null };
}

interface TxnWhereOpts {
  dateFrom?: string;
  dateTo?: string;
}

function buildTxnWhere(req: Request, opts: TxnWhereOpts = {}): Record<string, unknown> {
  const where: Record<string, unknown> = { ...visibleTransactionWhere(req) };
  if (opts.dateFrom || opts.dateTo) {
    const dateCond: { [Op.gte]?: string; [Op.lte]?: string } = {};
    if (opts.dateFrom) dateCond[Op.gte] = opts.dateFrom;
    if (opts.dateTo) dateCond[Op.lte] = opts.dateTo;
    where.date = dateCond;
  }
  return where;
}

/** GET /api/fx/exposure */
router.get('/exposure', async (req, res, next) => {
  try {
    const { dateFrom, dateTo, errors } = parseDateRange(req);
    if (errors.length > 0) {
      res.status(400).json({ error: errors[0] });
      return;
    }
    const { reportingCurrency, error: currencyError } = parseReportingCurrency(req);
    if (currencyError) {
      res.status(400).json({ error: currencyError });
      return;
    }

    const rows = await Transaction.findAll({
      where: buildTxnWhere(req, { dateFrom, dateTo }),
      attributes: ['currency', 'amount', 'date'],
      raw: true,
    });

    const asOf = dateTo ?? todayIso();
    const result = await computeCurrencyExposure(
      rows.map((r) => ({
        currency: r.currency,
        amount: r.amount,
        date: r.date,
      })),
      asOf,
      reportingCurrency,
      reportingFxLookup
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** GET /api/fx/fees */
router.get('/fees', async (req, res, next) => {
  try {
    const { dateFrom, dateTo, errors } = parseDateRange(req);
    if (errors.length > 0) {
      res.status(400).json({ error: errors[0] });
      return;
    }
    const limitParam = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(limitParam)
      ? Math.min(Math.max(1, Math.floor(limitParam)), MAX_FEE_RESULTS)
      : 100;

    const [accounts, txns] = await Promise.all([
      Account.findAll({
        where: visibleAccountWhere(req),
        attributes: ['id', 'name', 'defaultCurrency'],
        raw: true,
      }),
      Transaction.findAll({
        where: buildTxnWhere(req, { dateFrom, dateTo }),
        attributes: [
          'id',
          'accountId',
          'date',
          'currency',
          'amount',
          'merchantRaw',
          'merchantClean',
          'notes',
        ],
        order: [['date', 'DESC']],
        raw: true,
      }),
    ]);

    const accountById = new Map<
      number,
      { id: number; name: string; defaultCurrency: string | null }
    >((accounts as Array<{ id: number; name: string; defaultCurrency: string | null }>).map(
      (a) => [a.id, a]
    ));

    const flagged: Array<{
      transactionId: number;
      accountId: number;
      accountName: string | null;
      date: string;
      merchant: string;
      currency: string;
      amount: number;
      reason: string;
      confidence: 'high' | 'medium' | 'low' | null;
    }> = [];

    for (const txn of txns as Array<{
      id: number;
      accountId: number;
      date: string;
      currency: string;
      amount: string;
      merchantRaw: string | null;
      merchantClean: string | null;
      notes: string | null;
    }>) {
      const account = accountById.get(txn.accountId);
      const input: DetectFxFeeInput = {
        merchantRaw: txn.merchantRaw,
        merchantClean: txn.merchantClean,
        notes: txn.notes,
        amount: num(txn.amount) ?? 0,
        currency: txn.currency,
        accountDefaultCurrency: account?.defaultCurrency ?? null,
      };
      const detection = detectFxFee(input);
      if (!detection.isFxFee) continue;
      flagged.push({
        transactionId: txn.id,
        accountId: txn.accountId,
        accountName: account?.name ?? null,
        date: txn.date,
        merchant: txn.merchantClean || txn.merchantRaw || '',
        currency: txn.currency,
        amount: num(txn.amount) ?? 0,
        reason: detection.reason ?? '',
        confidence: detection.confidence,
      });
      if (flagged.length >= limit) break;
    }

    res.json({ fees: flagged, total: flagged.length, limit });
  } catch (err) {
    next(err);
  }
});

/** GET /api/fx/effective-rates */
router.get('/effective-rates', async (req, res, next) => {
  try {
    const { dateFrom, dateTo, errors } = parseDateRange(req);
    if (errors.length > 0) {
      res.status(400).json({ error: errors[0] });
      return;
    }
    const limitParam = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(limitParam)
      ? Math.min(Math.max(1, Math.floor(limitParam)), MAX_EFFECTIVE_RATE_RESULTS)
      : 100;

    const txns = (await Transaction.findAll({
      where: buildTxnWhere(req, { dateFrom, dateTo }),
      attributes: [
        'id',
        'accountId',
        'date',
        'currency',
        'amount',
        'linkedTransactionId',
        'merchantRaw',
        'merchantClean',
      ],
      order: [['date', 'DESC']],
      raw: true,
    })) as Array<{
      id: number;
      accountId: number;
      date: string;
      currency: string;
      amount: string;
      linkedTransactionId: number | null;
      merchantRaw: string | null;
      merchantClean: string | null;
    }>;

    const candidates: RateDerivationTxn[] = txns.map((t) => ({
      id: t.id,
      accountId: t.accountId,
      date: t.date,
      amount: t.amount,
      currency: t.currency,
      linkedTransactionId: t.linkedTransactionId,
    }));

    const results: Array<{
      transactionId: number;
      accountId: number;
      date: string;
      merchant: string;
      fromCurrency: string;
      toCurrency: string;
      nativeAmount: number;
      effectiveRate: number;
      source: 'linked_transaction' | 'paired_transfer';
      counterpartyTransactionId: number;
    }> = [];

    // Group by (accountId, date) so heuristic lookups are O(N) overall
    // instead of O(N²). For each txn we only need the candidates with the
    // same account and date.
    const byAccountDate = new Map<string, RateDerivationTxn[]>();
    for (const c of candidates) {
      const key = `${c.accountId}|${c.date}`;
      const arr = byAccountDate.get(key) ?? [];
      arr.push(c);
      byAccountDate.set(key, arr);
    }

    for (const target of candidates) {
      // Only attempt derivation for txns whose currency might differ from
      // the matched pair. Same-currency txns can't yield a rate.
      const sameDateAcc = byAccountDate.get(`${target.accountId}|${target.date}`) ?? [];
      const pool: RateDerivationTxn[] = sameDateAcc;
      // Also include the linked counterparty (it may be on a different
      // account-date bucket).
      if (target.linkedTransactionId != null) {
        const linked = candidates.find((c) => c.id === target.linkedTransactionId);
        if (linked && !pool.includes(linked)) pool.push(linked);
      }
      const r = deriveEffectiveRate(target, pool);
      if (!r) continue;
      const src = txns.find((t) => t.id === target.id);
      results.push({
        transactionId: target.id,
        accountId: target.accountId,
        date: target.date,
        merchant: src?.merchantClean || src?.merchantRaw || '',
        fromCurrency: r.fromCurrency,
        toCurrency: r.toCurrency,
        nativeAmount: num(target.amount) ?? 0,
        effectiveRate: r.rate,
        source: r.source,
        counterpartyTransactionId: r.counterpartyTxnId,
      });
      if (results.length >= limit) break;
    }

    res.json({ rates: results, total: results.length, limit });
  } catch (err) {
    next(err);
  }
});

/** GET /api/fx/reporting */
router.get('/reporting', async (req, res, next) => {
  try {
    const { dateFrom, dateTo, errors } = parseDateRange(req);
    if (errors.length > 0) {
      res.status(400).json({ error: errors[0] });
      return;
    }
    const { reportingCurrency, error: currencyError } = parseReportingCurrency(req);
    if (currencyError) {
      res.status(400).json({ error: currencyError });
      return;
    }

    const rows = (await Transaction.findAll({
      where: buildTxnWhere(req, { dateFrom, dateTo }),
      attributes: ['currency', 'amount'],
      raw: true,
    })) as Array<{ currency: string; amount: string }>;

    const totalSpend: Record<string, number> = {};
    const totalCredits: Record<string, number> = {};
    const transactionCounts: Record<string, number> = {};
    for (const row of rows) {
      const cur = (row.currency ?? '').toUpperCase().trim();
      if (!cur) continue;
      const amount = num(row.amount) ?? 0;
      transactionCounts[cur] = (transactionCounts[cur] ?? 0) + 1;
      if (amount < 0) {
        totalSpend[cur] = (totalSpend[cur] ?? 0) + Math.abs(amount);
      } else {
        totalCredits[cur] = (totalCredits[cur] ?? 0) + amount;
      }
    }
    const netSpend: Record<string, number> = {};
    const allCurrencies = new Set([
      ...Object.keys(totalSpend),
      ...Object.keys(totalCredits),
    ]);
    for (const cur of allCurrencies) {
      netSpend[cur] = (totalSpend[cur] ?? 0) - (totalCredits[cur] ?? 0);
    }

    const aggs: ReportingAggregate[] = [
      { key: 'totalSpend', byCurrency: totalSpend },
      { key: 'totalCredits', byCurrency: totalCredits },
      { key: 'netSpend', byCurrency: netSpend },
    ];
    const asOf = dateTo ?? todayIso();
    const normalized = await normalizeToReportingCurrency(
      aggs,
      reportingCurrency,
      asOf,
      reportingFxLookup
    );

    res.json({
      ...normalized,
      transactionCountByCurrency: transactionCounts,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
