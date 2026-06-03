/**
 * Pure deterministic insight detectors.
 *
 * Each detector takes an array of plain rows + a `{ now }` clock and returns
 * `DetectedInsight[]`. They never read the DB. The route loads rows from the
 * DB (`POST /api/insights/run`) and persists the returned findings.
 *
 * Severity policy:
 * - `info` — informational, no action needed (rare in this PR)
 * - `warning` — likely worth investigating (most spikes / duplicates land here)
 * - `critical` — high-confidence problem (settlement >$1000 imbalance)
 *
 * Each detector returns a stable `fingerprint` so re-runs are idempotent: the
 * route writes to a unique index `(household_id, type, fingerprint)`.
 *
 * Thresholds are intentionally conservative — false positives are costlier
 * than false negatives in an inbox UI. Where a number is non-obvious it has
 * a TODO with the rationale.
 */
import type { InsightSeverity, InsightType } from '../../models/Insight';

export type DetectorTransaction = {
  id: number;
  /** ISO YYYY-MM-DD date (DATEONLY). */
  date: string;
  /** Canonical merchant string (Transaction.merchantClean). */
  merchantClean: string;
  /** Negative = spend, positive = credit (codebase convention). */
  amount: number;
  currency: string;
  /** Resolved category (Transaction.finalCategory) — null = uncategorized. */
  finalCategory: string | null;
  /** Number of attached receipts. 0 = missing-receipt eligible. */
  receiptCount: number;
};

export type DetectorSettlement = {
  contactId: number;
  contactName: string;
  direction: 'i_paid_partner' | 'partner_paid_me';
  currency: string;
  /** Settlements are always stored positive — direction encodes the sign. */
  amount: number;
};

export type DetectedInsight = {
  type: InsightType;
  severity: InsightSeverity;
  title: string;
  description: string;
  entityType: string | null;
  entityId: number | null;
  fingerprint: string;
  metadata: unknown;
};

export type DetectorOptions = {
  now: Date;
  /**
   * Lowercased merchant names that are tracked subscriptions; `recurring_increase`
   * skips these so `subscription_price_increase` owns them (no double-surfacing of
   * the same price hike). The orchestrator builds this from both the subscription's
   * `normalizedName` and its display `name`, each lowercased — see the note in
   * `detectRecurringIncrease` and `runDetectorsForHousehold`.
   */
  subscriptionMerchants?: Set<string>;
};

// ---- helpers -----------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseDate(iso: string): Date {
  // DATEONLY strings ("YYYY-MM-DD") parse to UTC midnight which is fine for
  // our day-granularity comparisons.
  return new Date(`${iso}T00:00:00Z`);
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs((a.getTime() - b.getTime()) / MS_PER_DAY);
}

/** Inclusive YYYY-MM key for bucketing by calendar month. */
function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

function priorMonthKeys(now: Date, count: number): string[] {
  const out: string[] = [];
  for (let i = 1; i <= count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

function currentMonthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

function formatCurrency(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

// ---- detectDuplicateTransactions ---------------------------------------

const DUPLICATE_LOOKBACK_DAYS = 30;
const DUPLICATE_WINDOW_DAYS = 3;

export function detectDuplicateTransactions(
  rows: DetectorTransaction[],
  opts: DetectorOptions,
): DetectedInsight[] {
  const cutoff = new Date(opts.now.getTime() - DUPLICATE_LOOKBACK_DAYS * MS_PER_DAY);
  const eligible = rows.filter(
    (r) => r.amount < 0 && parseDate(r.date) >= cutoff,
  );

  // Group by (currency, merchant, abs amount) and look for pairs within 3 days
  const groups = new Map<string, DetectorTransaction[]>();
  for (const row of eligible) {
    const key = `${row.currency}|${row.merchantClean.toLowerCase()}|${Math.abs(row.amount).toFixed(2)}`;
    const arr = groups.get(key) ?? [];
    arr.push(row);
    groups.set(key, arr);
  }

  const out: DetectedInsight[] = [];
  const seenFingerprints = new Set<string>();

  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < list.length; i++) {
      const cluster: DetectorTransaction[] = [list[i]];
      for (let j = i + 1; j < list.length; j++) {
        if (daysBetween(parseDate(list[i].date), parseDate(list[j].date)) <= DUPLICATE_WINDOW_DAYS) {
          cluster.push(list[j]);
        }
      }
      if (cluster.length < 2) continue;
      const ids = cluster.map((r) => r.id).sort((a, b) => a - b);
      const fingerprint = `dup:${cluster[0].currency}:${cluster[0].merchantClean.toLowerCase()}:${ids.join(',')}`;
      if (seenFingerprints.has(fingerprint)) continue;
      seenFingerprints.add(fingerprint);

      const total = cluster.reduce((s, r) => s + Math.abs(r.amount), 0);
      out.push({
        type: 'duplicate_transactions',
        severity: 'warning',
        title: `Possible duplicate charge from ${cluster[0].merchantClean}`,
        description: `${cluster.length} charges of ${formatCurrency(Math.abs(cluster[0].amount), cluster[0].currency)} at ${cluster[0].merchantClean} within ${DUPLICATE_WINDOW_DAYS} days (total ${formatCurrency(total, cluster[0].currency)}).`,
        entityType: 'transaction',
        entityId: ids[0],
        fingerprint,
        metadata: {
          transactionIds: ids,
          merchant: cluster[0].merchantClean,
          amount: Math.abs(cluster[0].amount),
          currency: cluster[0].currency,
        },
      });
      // Skip past the cluster to avoid re-emitting subsets
      i += cluster.length - 1;
    }
  }
  return out;
}

// ---- detectMerchantSpendSpike ------------------------------------------

const SPIKE_HISTORY_MONTHS = 3;
const SPIKE_MULT = 2; // current > 2× prior avg
// TODO(threshold): conservative $50 floor avoids triggering on coffee — revisit
// after first round of usage to see how many false positives slip through.
const SPIKE_MIN_CURRENT = 50;

export function detectMerchantSpendSpike(
  rows: DetectorTransaction[],
  opts: DetectorOptions,
): DetectedInsight[] {
  const currentKey = currentMonthKey(opts.now);
  const priorKeys = new Set(priorMonthKeys(opts.now, SPIKE_HISTORY_MONTHS));

  type Bucket = { merchant: string; currency: string; current: number; priorByMonth: Map<string, number> };
  const buckets = new Map<string, Bucket>();

  for (const row of rows) {
    if (row.amount >= 0) continue;
    const merch = row.merchantClean.trim();
    if (!merch) continue;
    const month = monthKey(row.date);
    const isCurrent = month === currentKey;
    const isPrior = priorKeys.has(month);
    if (!isCurrent && !isPrior) continue;
    const key = `${row.currency}|${merch.toLowerCase()}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { merchant: merch, currency: row.currency, current: 0, priorByMonth: new Map() };
      buckets.set(key, bucket);
    }
    const absAmt = Math.abs(row.amount);
    if (isCurrent) {
      bucket.current += absAmt;
    } else {
      bucket.priorByMonth.set(month, (bucket.priorByMonth.get(month) ?? 0) + absAmt);
    }
  }

  const out: DetectedInsight[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.current < SPIKE_MIN_CURRENT) continue;
    if (bucket.priorByMonth.size === 0) continue;
    let priorSum = 0;
    for (const v of bucket.priorByMonth.values()) priorSum += v;
    const priorAvg = priorSum / bucket.priorByMonth.size;
    if (priorAvg <= 0) continue;
    if (bucket.current <= SPIKE_MULT * priorAvg) continue;
    const multiplier = bucket.current / priorAvg;
    const severity: InsightSeverity = multiplier >= 4 ? 'critical' : 'warning';
    out.push({
      type: 'merchant_spend_spike',
      severity,
      title: `Spending up at ${bucket.merchant}`,
      description: `Spent ${formatCurrency(bucket.current, bucket.currency)} at ${bucket.merchant} this month vs ${formatCurrency(priorAvg, bucket.currency)}/mo average over the prior ${bucket.priorByMonth.size} month(s).`,
      entityType: null,
      entityId: null,
      fingerprint: `spike:${bucket.currency}:${bucket.merchant.toLowerCase()}:${currentKey}`,
      metadata: {
        merchant: bucket.merchant,
        currency: bucket.currency,
        currentMonth: currentKey,
        currentAmount: bucket.current,
        priorAvg,
        multiplier,
      },
    });
  }
  return out;
}

// ---- detectRecurringIncrease -------------------------------------------

// We treat any merchant that charged in each of the prior 3 months at roughly
// stable amounts as "recurring" enough to call a price increase. Real recurring
// detection (cadence-aware) lives in routes/recurring.ts; this detector is a
// deliberately simpler month-bucket comparison so it covers the common
// subscription-price-hike case without overlapping that route's contract.
const RECURRING_HISTORY_MONTHS = 3;
const RECURRING_INCREASE_RATIO = 1.2; // >20%
// TODO(threshold): 1.2 captures subscription bumps without churning on micro-
// inflation. Revisit if Connor sees false positives.

export function detectRecurringIncrease(
  rows: DetectorTransaction[],
  opts: DetectorOptions,
): DetectedInsight[] {
  const currentKey = currentMonthKey(opts.now);
  const priorKeys = priorMonthKeys(opts.now, RECURRING_HISTORY_MONTHS);

  type Bucket = {
    merchant: string;
    currency: string;
    byMonth: Map<string, { sum: number; ids: number[] }>;
  };
  const buckets = new Map<string, Bucket>();

  for (const row of rows) {
    if (row.amount >= 0) continue;
    const merch = row.merchantClean.trim();
    if (!merch) continue;
    const month = monthKey(row.date);
    if (month !== currentKey && !priorKeys.includes(month)) continue;
    const key = `${row.currency}|${merch.toLowerCase()}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { merchant: merch, currency: row.currency, byMonth: new Map() };
      buckets.set(key, bucket);
    }
    const existing = bucket.byMonth.get(month) ?? { sum: 0, ids: [] };
    existing.sum += Math.abs(row.amount);
    existing.ids.push(row.id);
    bucket.byMonth.set(month, existing);
  }

  const out: DetectedInsight[] = [];
  for (const bucket of buckets.values()) {
    // Skip merchants that are tracked subscriptions — `subscription_price_increase`
    // owns price hikes for those, so emitting a `recurring_increase` too would
    // double-surface the same event. `bucket.merchant` is `merchantClean.trim()`,
    // so we compare its lowercase against the (already-lowercased) guard set. The
    // orchestrator seeds that set with BOTH the subscription's `normalizedName`
    // (which for detection-sourced subs is `merchantClean.trim().toLowerCase()` —
    // identical to this key) AND its display `name` lowercased, so manually-created
    // or renamed subs whose `normalizedName` diverges from the live `merchantClean`
    // are still caught. See `runDetectorsForHousehold`.
    if (opts.subscriptionMerchants?.has(bucket.merchant.toLowerCase())) continue;

    const currentBucket = bucket.byMonth.get(currentKey);
    if (!currentBucket) continue;

    // Require ALL prior months to have a charge — otherwise this isn't recurring
    const priorSeries: number[] = [];
    for (const key of priorKeys) {
      const m = bucket.byMonth.get(key);
      if (!m) {
        // missing month — bail
        priorSeries.length = 0;
        break;
      }
      priorSeries.push(m.sum);
    }
    if (priorSeries.length < RECURRING_HISTORY_MONTHS) continue;

    const priorAvg = priorSeries.reduce((a, b) => a + b, 0) / priorSeries.length;
    if (priorAvg <= 0) continue;
    if (currentBucket.sum < priorAvg * RECURRING_INCREASE_RATIO) continue;

    const pct = ((currentBucket.sum - priorAvg) / priorAvg) * 100;
    out.push({
      type: 'recurring_increase',
      severity: 'warning',
      title: `Recurring charge at ${bucket.merchant} increased`,
      description: `Recurring charge at ${bucket.merchant} is ${formatCurrency(currentBucket.sum, bucket.currency)} this month vs ${formatCurrency(priorAvg, bucket.currency)}/mo over the prior ${RECURRING_HISTORY_MONTHS} months (+${pct.toFixed(0)}%).`,
      entityType: 'transaction',
      entityId: currentBucket.ids[0] ?? null,
      fingerprint: `recurring:${bucket.currency}:${bucket.merchant.toLowerCase()}:${currentKey}`,
      metadata: {
        merchant: bucket.merchant,
        currency: bucket.currency,
        priorAmount: priorAvg,
        currentAmount: currentBucket.sum,
        currentMonth: currentKey,
        supportingTransactionIds: currentBucket.ids,
      },
    });
  }
  return out;
}

// ---- detectMissingReceipt ----------------------------------------------

const MISSING_RECEIPT_DAYS = 7;
const MISSING_RECEIPT_MIN = 100;

export function detectMissingReceipt(
  rows: DetectorTransaction[],
  opts: DetectorOptions,
): DetectedInsight[] {
  const cutoff = new Date(opts.now.getTime() - MISSING_RECEIPT_DAYS * MS_PER_DAY);
  const out: DetectedInsight[] = [];
  for (const row of rows) {
    if (row.amount >= 0) continue;
    if (Math.abs(row.amount) < MISSING_RECEIPT_MIN) continue;
    if (row.receiptCount > 0) continue;
    if (parseDate(row.date) > cutoff) continue;
    out.push({
      type: 'missing_receipt',
      severity: 'info',
      title: `Receipt missing for ${formatCurrency(Math.abs(row.amount), row.currency)} at ${row.merchantClean}`,
      description: `Large charge from ${row.date} has no attached receipt. Add one for cleaner records.`,
      entityType: 'transaction',
      entityId: row.id,
      fingerprint: `missing-receipt:${row.id}`,
      metadata: {
        transactionId: row.id,
        amount: Math.abs(row.amount),
        currency: row.currency,
        merchant: row.merchantClean,
        date: row.date,
      },
    });
  }
  return out;
}

// ---- detectUnusualCategorySpend ----------------------------------------

const CATEGORY_HISTORY_MONTHS = 3;
const CATEGORY_MULT = 2;
const CATEGORY_MIN_CURRENT = 100;

export function detectUnusualCategorySpend(
  rows: DetectorTransaction[],
  opts: DetectorOptions,
): DetectedInsight[] {
  const currentKey = currentMonthKey(opts.now);
  const priorKeys = new Set(priorMonthKeys(opts.now, CATEGORY_HISTORY_MONTHS));

  type Bucket = { category: string; currency: string; current: number; priorByMonth: Map<string, number> };
  const buckets = new Map<string, Bucket>();

  for (const row of rows) {
    if (row.amount >= 0) continue;
    if (!row.finalCategory) continue;
    const month = monthKey(row.date);
    const isCurrent = month === currentKey;
    const isPrior = priorKeys.has(month);
    if (!isCurrent && !isPrior) continue;
    const key = `${row.currency}|${row.finalCategory.toLowerCase()}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        category: row.finalCategory,
        currency: row.currency,
        current: 0,
        priorByMonth: new Map(),
      };
      buckets.set(key, bucket);
    }
    const absAmt = Math.abs(row.amount);
    if (isCurrent) {
      bucket.current += absAmt;
    } else {
      bucket.priorByMonth.set(month, (bucket.priorByMonth.get(month) ?? 0) + absAmt);
    }
  }

  const out: DetectedInsight[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.current < CATEGORY_MIN_CURRENT) continue;
    if (bucket.priorByMonth.size === 0) continue;
    let priorSum = 0;
    for (const v of bucket.priorByMonth.values()) priorSum += v;
    const priorAvg = priorSum / bucket.priorByMonth.size;
    if (priorAvg <= 0) continue;
    if (bucket.current <= CATEGORY_MULT * priorAvg) continue;
    const multiplier = bucket.current / priorAvg;
    out.push({
      type: 'unusual_category_spend',
      severity: multiplier >= 4 ? 'critical' : 'warning',
      title: `Unusual ${bucket.category} spend this month`,
      description: `Spent ${formatCurrency(bucket.current, bucket.currency)} on ${bucket.category} this month vs ${formatCurrency(priorAvg, bucket.currency)}/mo average over the prior ${bucket.priorByMonth.size} month(s).`,
      entityType: null,
      entityId: null,
      fingerprint: `category-spike:${bucket.currency}:${bucket.category.toLowerCase()}:${currentKey}`,
      metadata: {
        category: bucket.category,
        currency: bucket.currency,
        currentMonth: currentKey,
        currentAmount: bucket.current,
        priorAvg,
        multiplier,
      },
    });
  }
  return out;
}

// ---- detectSettlementImbalance -----------------------------------------

const SETTLEMENT_MIN_NET = 100;
const SETTLEMENT_CRITICAL_NET = 1000;

export function detectSettlementImbalance(
  rows: DetectorSettlement[],
): DetectedInsight[] {
  type Bucket = { contactId: number; contactName: string; currency: string; net: number };
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    const key = `${row.contactId}|${row.currency}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        contactId: row.contactId,
        contactName: row.contactName,
        currency: row.currency,
        net: 0,
      };
      buckets.set(key, bucket);
    }
    const signed = row.direction === 'i_paid_partner' ? row.amount : -row.amount;
    bucket.net += signed;
  }
  const out: DetectedInsight[] = [];
  for (const bucket of buckets.values()) {
    const absNet = Math.abs(bucket.net);
    if (absNet < SETTLEMENT_MIN_NET) continue;
    const direction = bucket.net > 0 ? 'partner_owes_you' : 'you_owe_partner';
    const severity: InsightSeverity = absNet >= SETTLEMENT_CRITICAL_NET ? 'critical' : 'warning';
    const phrase = direction === 'partner_owes_you'
      ? `${bucket.contactName} owes you ${formatCurrency(absNet, bucket.currency)} net`
      : `You owe ${bucket.contactName} ${formatCurrency(absNet, bucket.currency)} net`;
    out.push({
      type: 'settlement_imbalance',
      severity,
      title: `Settlement imbalance with ${bucket.contactName}`,
      description: `${phrase}. Review your partner settlements to record the offsetting payment.`,
      entityType: 'contact',
      entityId: bucket.contactId,
      fingerprint: `settlement:${bucket.contactId}:${bucket.currency}`,
      metadata: {
        contactId: bucket.contactId,
        contactName: bucket.contactName,
        currency: bucket.currency,
        netAmount: absNet,
        direction,
      },
    });
  }
  return out;
}
