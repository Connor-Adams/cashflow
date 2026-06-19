/**
 * Run every deterministic detector against a household and upsert the
 * resulting `Insight` rows.
 *
 * Idempotency: detectors return a stable `fingerprint` (e.g. sorted txn ids).
 * We upsert by `(household_id, type, fingerprint)`. A re-run of the same
 * detector will refresh `metadata`/`detected_at` but won't churn statuses —
 * if the user already dismissed/resolved a finding, we preserve that. That
 * means a "dismissed" duplicate stays dismissed even if the detector still
 * surfaces it. To re-surface, drop the row.
 *
 * Scope: this is the deterministic layer. Issue #210 (future) layers an AI
 * review pass on top — it reads the same `insights` table.
 */
import { Op } from 'sequelize';
import { Insight, Transaction, PartnerSettlement, Contact, Receipt, PlannedEvent, Account, sequelize } from '../models';
import { isNonSpend } from '../summary/classifyTransactionFlow';
import { assembleForecast } from '../forecast/assembleForecast';
import { buildForecast } from '../forecast/buildForecast';
import {
  detectDuplicateTransactions,
  detectMerchantSpendSpike,
  detectRecurringIncrease,
  detectMissingReceipt,
  detectUnusualCategorySpend,
  detectSettlementImbalance,
  detectCashRunwayLow,
  detectCategoryTrend,
} from './detectors';
import type {
  DetectorTransaction,
  DetectorSettlement,
  DetectorRunwayPoint,
  DetectedInsight,
} from './detectors';

const TRANSACTION_LOOKBACK_DAYS = 180;
// Runway detector horizon — how far ahead we project the daily balance series.
// Matches RUNWAY_HORIZON_DAYS in detectors/index.ts (kept here so the
// projection window covers the detector's scan window).
const RUNWAY_HORIZON_DAYS = 30;

// Cash-bearing account types excluded from the forecast (investment value isn't
// spendable cash); mirrors assembleForecast's own exclusion list.
const FORECAST_EXCLUDED_TYPES = new Set(['investment']);

export type RunDetectorsResult = {
  created: number;
  refreshed: number;
  total: number;
  detectorCounts: Record<string, number>;
};

async function loadTransactions(
  householdId: number,
  now: Date,
): Promise<DetectorTransaction[]> {
  const cutoff = new Date(now.getTime() - TRANSACTION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const allRows = await Transaction.findAll({
    where: { householdId, date: { [Op.gte]: cutoffIso } },
    attributes: ['id', 'date', 'merchantClean', 'amount', 'currency', 'finalCategory', 'txnType'],
    include: [{ association: 'account', attributes: ['accountType'] }],
    raw: true,
  });
  // Money-movement rows (transfers, brokerage buys, statement payments,
  // refunds/rewards, plus anything on an investment account) are not spend.
  // Without this peel, recurring same-amount transfers emit duplicate
  // "charges" and a growing card bill payment emits a spend spike — the
  // insight descriptions would present money movement as spending.
  const rows = allRows.filter((r) => {
    const raw = r as unknown as Record<string, unknown>;
    return !isNonSpend(
      (raw.txnType ?? null) as string | null,
      (raw['account.accountType'] ?? null) as string | null,
    );
  });
  const ids = rows.map((r) => r.id);
  // Receipt counts per transaction — single query, single pass aggregate
  const receipts = ids.length === 0 ? [] : await Receipt.findAll({
    where: { transactionId: { [Op.in]: ids } },
    attributes: ['transactionId'],
    raw: true,
  });
  const countByTxn = new Map<number, number>();
  for (const r of receipts) {
    countByTxn.set(r.transactionId, (countByTxn.get(r.transactionId) ?? 0) + 1);
  }
  return rows.map((r) => ({
    id: r.id,
    date: String(r.date),
    merchantClean: String(r.merchantClean ?? ''),
    amount: Number(r.amount),
    currency: String(r.currency),
    finalCategory: r.finalCategory ?? null,
    receiptCount: countByTxn.get(r.id) ?? 0,
  }));
}

async function loadSettlements(householdId: number): Promise<DetectorSettlement[]> {
  // Pair with contact names so the insight description reads natural.
  const rows = await PartnerSettlement.findAll({
    where: { householdId },
    raw: true,
  });
  const contactIds = Array.from(new Set(rows.map((r) => r.contactId)));
  const contacts = contactIds.length === 0 ? [] : await Contact.findAll({
    where: { id: { [Op.in]: contactIds } },
    attributes: ['id', 'name'],
    raw: true,
  });
  const nameById = new Map<number, string>();
  for (const c of contacts) nameById.set(c.id, c.name || `Contact #${c.id}`);
  return rows.map((r) => ({
    contactId: r.contactId,
    contactName: nameById.get(r.contactId) || `Contact #${r.contactId}`,
    direction: r.direction,
    currency: r.currency,
    amount: Number(r.amount),
  }));
}

function isoFromDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Build the per-currency projected daily-balance series the cash-runway
 * detector consumes. Enumerates the household's cash currencies (non-investment
 * accounts), then runs the SAME forecast assembly + daily-series math the
 * `/api/forecast` route uses, once per currency, over the runway horizon. The
 * detector stays DB-free; this loader is the DB→rows shaping step, mirroring
 * `loadTransactions`/`loadSettlements`.
 */
async function loadRunwayPoints(
  householdId: number,
  now: Date,
): Promise<DetectorRunwayPoint[]> {
  const dateFrom = isoFromDate(now);
  const dateTo = isoFromDate(new Date(now.getTime() + RUNWAY_HORIZON_DAYS * 24 * 60 * 60 * 1000));

  // Distinct cash currencies across eligible (non-investment, open) accounts.
  const accounts = await Account.findAll({ where: { householdId } });
  const currencies = new Set<string>();
  for (const acc of accounts) {
    if (FORECAST_EXCLUDED_TYPES.has(acc.accountType)) continue;
    if (acc.closedAt && acc.closedAt <= dateFrom) continue;
    if (acc.defaultCurrency) currencies.add(acc.defaultCurrency);
  }

  const points: DetectorRunwayPoint[] = [];
  for (const currency of currencies) {
    const assembled = await assembleForecast({
      householdId,
      dateFrom,
      dateTo,
      currency,
    });
    const result = buildForecast({
      openingBalance: assembled.openingBalance,
      occurrences: assembled.occurrences,
      dateFrom,
      dateTo,
      currency: assembled.currency,
    });
    for (const p of result.dailyPoints) {
      points.push({ date: p.date, balance: p.balance, currency: assembled.currency });
    }
  }
  return points;
}

/**
 * Upsert one detected insight, keyed by (householdId, type, fingerprint).
 * Refreshes content fields but NEVER writes `status`, so a user's
 * dismissed/resolved state is preserved across re-runs. Caller supplies the
 * transaction. Returns 'created' | 'refreshed'.
 */
export async function upsertInsight(
  householdId: number,
  f: DetectedInsight,
  opts: { now: Date; userId: number | null },
  t: import('sequelize').Transaction,
): Promise<'created' | 'refreshed'> {
  const existing = await Insight.findOne({
    where: { householdId, type: f.type, fingerprint: f.fingerprint },
    transaction: t,
  });
  if (existing) {
    existing.set('severity', f.severity);
    existing.set('title', f.title);
    existing.set('description', f.description);
    existing.set('entityType', f.entityType);
    existing.set('entityId', f.entityId);
    existing.set('metadata', f.metadata);
    existing.set('detectedAt', opts.now);
    await existing.save({ transaction: t });
    return 'refreshed';
  }
  await Insight.create(
    {
      householdId,
      userId: opts.userId,
      type: f.type,
      severity: f.severity,
      title: f.title,
      description: f.description,
      entityType: f.entityType,
      entityId: f.entityId,
      status: 'open',
      fingerprint: f.fingerprint,
      metadata: f.metadata,
      detectedAt: opts.now,
    },
    { transaction: t },
  );
  return 'created';
}

export async function runDetectorsForHousehold(
  householdId: number,
  options?: { now?: Date; userId?: number | null },
): Promise<RunDetectorsResult> {
  const now = options?.now ?? new Date();
  const userId = options?.userId ?? null;

  const transactions = await loadTransactions(householdId, now);
  const settlements = await loadSettlements(householdId);
  const runwayPoints = await loadRunwayPoints(householdId, now);

  // Merchants we already track as subscriptions — `recurring_increase` skips
  // these so `subscription_price_increase` (the dedicated subscription-price
  // detector) owns their price hikes instead of double-surfacing them. We seed
  // the guard set with BOTH `normalizedName` and the display `name`, each
  // lowercased: `recurring_increase` buckets by `merchantClean.trim().toLowerCase()`,
  // and while a detection-sourced sub's `normalizedName` equals exactly that, a
  // manually-created or renamed sub may store a `normalizedName` that no longer
  // matches the live `merchantClean` — including the display `name` lowercased
  // catches that case.
  const subRows = await PlannedEvent.findAll({
    where: { householdId, kind: 'subscription' },
    attributes: ['name', 'normalizedName'],
    raw: true,
  });
  const subscriptionMerchants = new Set<string>();
  for (const r of subRows) {
    const normalized = String(r.normalizedName ?? '').trim().toLowerCase();
    if (normalized) subscriptionMerchants.add(normalized);
    const display = String(r.name ?? '').trim().toLowerCase();
    if (display) subscriptionMerchants.add(display);
  }

  const findings: DetectedInsight[] = [
    ...detectDuplicateTransactions(transactions, { now }),
    ...detectMerchantSpendSpike(transactions, { now }),
    ...detectRecurringIncrease(transactions, { now, subscriptionMerchants }),
    ...detectMissingReceipt(transactions, { now }),
    ...detectUnusualCategorySpend(transactions, { now }),
    ...detectCategoryTrend(transactions, { now }),
    ...detectCashRunwayLow(runwayPoints, { now }),
    ...detectSettlementImbalance(settlements),
  ];

  const detectorCounts: Record<string, number> = {};
  for (const f of findings) {
    detectorCounts[f.type] = (detectorCounts[f.type] ?? 0) + 1;
  }

  let created = 0;
  let refreshed = 0;

  // Persist inside a transaction so a partial run doesn't leave inconsistent
  // state. Upsert by (household_id, type, fingerprint).
  await sequelize.transaction(async (t) => {
    for (const f of findings) {
      const r = await upsertInsight(householdId, f, { now, userId }, t);
      if (r === 'created') created++; else refreshed++;
    }
  });

  return { created, refreshed, total: findings.length, detectorCounts };
}
