/**
 * Pure money-leak detectors (Cashflow #220).
 *
 * Each detector inspects already-derived signals (subscriptions, recurring
 * transaction groups, aggregated delivery spend) and emits zero or more
 * LeakRow records. The detectors do NOT touch the DB and do NOT consult
 * Express — that keeps them trivially unit-testable.
 *
 * The set of detectors is intentionally narrow at launch: we surface only
 * the leaks that are deterministic from existing data (subscriptions +
 * transaction signals). Adding new detectors (e.g. unused services from
 * "no usage signal in last 60d") is a matter of dropping a new pure
 * function in here and threading its output into detectMoneyLeaks.
 *
 * De-duplication is handled centrally: detectMoneyLeaks() applies a
 * priority ordering so a subscription that is BOTH a price-increase AND
 * "small" shows up under exactly one leak type — never both.
 */

import type { MoneyLeakType } from './../models/MoneyLeakDismissal';
import type { SubscriptionCadence } from './../models/PlannedEvent';
import type { SubscriptionStatus } from './../expectations/subscriptionMapper';

// Re-export for convenience.
export type { MoneyLeakType } from './../models/MoneyLeakDismissal';

/**
 * Detector input row representing one active/cancelled/ignored subscription
 * the optimizer has already detected.
 */
export interface LeakSubscription {
  id: number;
  merchantName: string;
  normalizedName: string;
  currency: string;
  amount: number;
  cadence: SubscriptionCadence;
  annualizedCost: number;
  status: SubscriptionStatus;
  priceChangeDetected: boolean;
  category: string | null;
  lastChargeDate: string;
  nextExpectedDate: string | null;
}

/**
 * Detector input row representing one recurring-charge group as produced by
 * detectRecurring(). We keep this thin (we only need merchant + amount +
 * cadence + category) so the route layer doesn't have to hand us the full
 * RecurringItem shape.
 */
export interface LeakRecurringGroup {
  merchant: string;
  currency: string;
  cadence: 'monthly' | 'weekly';
  avgAmount: number;
  occurrences: number;
  category: string | null;
  lastSeen: string;
}

/** Per-currency aggregate of recent delivery-fee-ish spend (last 90 days). */
export interface LeakDeliverySpend {
  currency: string;
  total90d: number;
  transactionCount: number;
}

export interface LeakDetectorInput {
  subscriptions: LeakSubscription[];
  recurringGroups: LeakRecurringGroup[];
  deliverySpend: LeakDeliverySpend[];
  /**
   * Dismissed leak keys formatted as `${leakType}|${identityKey}`. Items
   * matching a dismissed key are filtered out of both `items` and `totals`.
   */
  dismissals: Set<string>;
  /** Optional currency filter — only leaks in this currency are returned. */
  currency?: string;
}

/**
 * Severity tier surfaced to the UI. We classify leaks coarsely so the
 * dashboard can sort by user impact without re-implementing the heuristic
 * client-side.
 */
export type LeakSeverity = 'low' | 'medium' | 'high';

export interface LeakRow {
  leakType: MoneyLeakType;
  /** Stable per-instance key — used for dismissals (POST {leakType, identityKey}). */
  identityKey: string;
  title: string;
  description: string;
  currency: string;
  monthlyImpact: number;
  annualImpact: number;
  severity: LeakSeverity;
  /** Free-form payload — IDs, merchant lists, anything the UI wants. */
  meta: Record<string, unknown>;
}

export interface LeakTotals {
  byCurrency: Array<{
    currency: string;
    monthlyImpact: number;
    annualImpact: number;
    count: number;
  }>;
}

export interface LeakDetectorOutput {
  items: LeakRow[];
  totals: LeakTotals;
}

/**
 * Threshold for the small_subscription detector. Annualized cost under this
 * value triggers the leak — the idea being that small recurring charges add
 * up to real money but each one feels too small to act on individually.
 * Tuned so $9.99/mo passes (= $119.88/yr), but $11/mo (= $132/yr) does not.
 */
export const SMALL_SUBSCRIPTION_ANNUAL_MAX = 120;

/**
 * Threshold for the delivery_fee_high detector. If a household spent more
 * than this in delivery-fee-like categories over the trailing 90 days, we
 * flag it. 90d → annualized via *4 to roughly project a year's drag.
 */
export const DELIVERY_FEE_QUARTERLY_MIN = 100;

/**
 * Threshold for the duplicate_service detector. Two or more active
 * subscriptions in the same category+currency triggers — three or more
 * lifts the severity. (A "duplicate service" cluster of two is the most
 * common pattern: two streaming services, two cloud-storage tiers.)
 */
const DUPLICATE_CLUSTER_MIN = 2;

const FEE_KEYWORDS = [
  'fee',
  'interest',
  'atm',
  'overdraft',
  'service charge',
  'foreign exchange',
  'nsf',
  'late payment',
];

/**
 * Returns true if a merchant or category looks like a fee charge worth
 * flagging. Heuristic: substring match against FEE_KEYWORDS (case-insensitive),
 * checked against the merchant first and the category as a fallback.
 */
export function isFeeMerchant(
  merchant: string,
  category: string | null,
): boolean {
  const m = merchant.toLowerCase();
  for (const kw of FEE_KEYWORDS) {
    if (m.includes(kw)) return true;
  }
  if (category) {
    const c = category.toLowerCase();
    if (c.includes('fee')) return true;
    if (c.includes('interest')) return true;
  }
  return false;
}

function annualToMonthly(annual: number): number {
  return annual / 12;
}

/**
 * Human-readable per-period phrase for a subscription cadence, used in leak
 * copy like "$9.99 per month". Covers every SubscriptionCadence — the old
 * `cadence === 'monthly' ? 'month' : 'week'` binarized everything else, so a
 * yearly sub read as "per week". Falls back to "month" for any unknown value.
 */
function cadenceLabel(cadence: SubscriptionCadence): string {
  switch (cadence) {
    case 'weekly':
      return 'week';
    case 'monthly':
      return 'month';
    case 'quarterly':
      return 'quarter';
    case 'semiannual':
      return '6 months';
    case 'annual':
      return 'year';
    default:
      return 'month';
  }
}

function pushTotal(
  totals: Map<string, LeakTotals['byCurrency'][number]>,
  currency: string,
  monthly: number,
  annual: number,
): void {
  const bucket = totals.get(currency) ?? {
    currency,
    monthlyImpact: 0,
    annualImpact: 0,
    count: 0,
  };
  bucket.monthlyImpact += monthly;
  bucket.annualImpact += annual;
  bucket.count += 1;
  totals.set(currency, bucket);
}

function severityFor(annualImpact: number): LeakSeverity {
  if (annualImpact >= 240) return 'high'; // $20+/mo equivalent
  if (annualImpact >= 60) return 'medium';
  return 'low';
}

function dismissedKey(leakType: MoneyLeakType, identityKey: string): string {
  return `${leakType}|${identityKey}`;
}

/**
 * Run all detectors against the supplied input. Returns leak rows in
 * descending order by annualImpact, plus per-currency rollups.
 *
 * De-duplication: subscription_price_increase is checked first. If a sub
 * triggers price_increase, it is removed from the candidate pool for the
 * other subscription-derived detectors (small_subscription, duplicate_service).
 * That way a $5/mo cheap sub with a price hike shows up once under
 * "Subscription price increase" and not also under "Small subscription".
 *
 * recurring_fee skips merchants that already have a subscription row of
 * the same normalized name + currency — a subscription with a fee-looking
 * name (e.g. "Bank Service Charge") would otherwise surface twice.
 */
export function detectMoneyLeaks(
  input: LeakDetectorInput,
): LeakDetectorOutput {
  const items: LeakRow[] = [];
  const totals = new Map<string, LeakTotals['byCurrency'][number]>();

  const inCurrencyFilter = (c: string): boolean =>
    !input.currency || c === input.currency;

  const usedSubscriptionIds = new Set<number>();
  const activeSubs = input.subscriptions.filter((s) => s.status === 'active');

  // 1. subscription_price_increase
  for (const sub of activeSubs) {
    if (!sub.priceChangeDetected) continue;
    if (!inCurrencyFilter(sub.currency)) continue;
    const identityKey = String(sub.id);
    if (input.dismissals.has(dismissedKey('subscription_price_increase', identityKey))) {
      usedSubscriptionIds.add(sub.id);
      continue;
    }
    const annual = sub.annualizedCost;
    const monthly = annualToMonthly(annual);
    items.push({
      leakType: 'subscription_price_increase',
      identityKey,
      title: `${sub.merchantName} price went up`,
      description: `Your ${sub.merchantName} subscription is now ${sub.amount.toFixed(2)} ${sub.currency} per ${cadenceLabel(sub.cadence)}.`,
      currency: sub.currency,
      monthlyImpact: monthly,
      annualImpact: annual,
      severity: severityFor(annual),
      meta: {
        subscriptionId: sub.id,
        category: sub.category,
        amount: sub.amount,
        cadence: sub.cadence,
      },
    });
    pushTotal(totals, sub.currency, monthly, annual);
    usedSubscriptionIds.add(sub.id);
  }

  // 2. duplicate_service — cluster active subs by category+currency.
  // Only emits leaks for clusters of >=2 in the same category. Each cluster
  // contributes ONE leak row to the dashboard (not one per duplicate).
  // Subscriptions that already triggered price_increase are excluded from
  // clustering (priority: price_increase > duplicate).
  const clusters = new Map<
    string,
    { currency: string; category: string; subs: LeakSubscription[] }
  >();
  for (const sub of activeSubs) {
    if (usedSubscriptionIds.has(sub.id)) continue;
    if (!sub.category) continue;
    if (!inCurrencyFilter(sub.currency)) continue;
    const key = `${sub.currency}|${sub.category}`;
    const cluster = clusters.get(key) ?? {
      currency: sub.currency,
      category: sub.category,
      subs: [],
    };
    cluster.subs.push(sub);
    clusters.set(key, cluster);
  }
  for (const cluster of clusters.values()) {
    if (cluster.subs.length < DUPLICATE_CLUSTER_MIN) continue;
    const identityKey = `${cluster.currency}|${cluster.category}`;
    if (input.dismissals.has(dismissedKey('duplicate_service', identityKey))) {
      // Mark these subs as used so they don't double-count in small_subscription.
      for (const s of cluster.subs) usedSubscriptionIds.add(s.id);
      continue;
    }
    const annual = cluster.subs.reduce((s, sub) => s + sub.annualizedCost, 0);
    const monthly = annualToMonthly(annual);
    const merchants = cluster.subs.map((s) => s.merchantName).join(', ');
    items.push({
      leakType: 'duplicate_service',
      identityKey,
      title: `${cluster.subs.length} active ${cluster.category} subscriptions`,
      description: `You have multiple active ${cluster.category} services in ${cluster.currency}: ${merchants}. Pick the one you use most.`,
      currency: cluster.currency,
      monthlyImpact: monthly,
      annualImpact: annual,
      severity: cluster.subs.length >= 3 ? 'high' : 'medium',
      meta: {
        category: cluster.category,
        subscriptionIds: cluster.subs.map((s) => s.id),
        merchants: cluster.subs.map((s) => s.merchantName),
      },
    });
    pushTotal(totals, cluster.currency, monthly, annual);
    // Mark these subs as used so a cheap clustered sub doesn't also surface
    // under small_subscription.
    for (const s of cluster.subs) usedSubscriptionIds.add(s.id);
  }

  // 3. small_subscription
  for (const sub of activeSubs) {
    if (usedSubscriptionIds.has(sub.id)) continue;
    if (!inCurrencyFilter(sub.currency)) continue;
    if (sub.annualizedCost >= SMALL_SUBSCRIPTION_ANNUAL_MAX) continue;
    const identityKey = String(sub.id);
    if (input.dismissals.has(dismissedKey('small_subscription', identityKey))) {
      usedSubscriptionIds.add(sub.id);
      continue;
    }
    const annual = sub.annualizedCost;
    const monthly = annualToMonthly(annual);
    items.push({
      leakType: 'small_subscription',
      identityKey,
      title: `${sub.merchantName} is a small recurring charge`,
      description: `Costs ${sub.amount.toFixed(2)} ${sub.currency} per ${cadenceLabel(sub.cadence)} (${annual.toFixed(2)} ${sub.currency}/year). Worth a look.`,
      currency: sub.currency,
      monthlyImpact: monthly,
      annualImpact: annual,
      severity: severityFor(annual),
      meta: {
        subscriptionId: sub.id,
        category: sub.category,
        amount: sub.amount,
        cadence: sub.cadence,
      },
    });
    pushTotal(totals, sub.currency, monthly, annual);
    usedSubscriptionIds.add(sub.id);
  }

  // 4. recurring_fee
  // Skip merchants already represented by a subscription row in the same
  // currency — otherwise a bank-fee subscription surfaces twice.
  const subscriptionKeys = new Set<string>();
  for (const sub of input.subscriptions) {
    subscriptionKeys.add(`${sub.normalizedName}|${sub.currency}`);
  }
  for (const group of input.recurringGroups) {
    if (!inCurrencyFilter(group.currency)) continue;
    if (!isFeeMerchant(group.merchant, group.category)) continue;
    const normalizedMerchant = group.merchant.trim().toLowerCase();
    const subKey = `${normalizedMerchant}|${group.currency}`;
    if (subscriptionKeys.has(subKey)) continue;
    const identityKey = `${normalizedMerchant}|${group.currency}`;
    if (input.dismissals.has(dismissedKey('recurring_fee', identityKey))) {
      continue;
    }
    const annual =
      group.cadence === 'monthly'
        ? group.avgAmount * 12
        : group.avgAmount * 52;
    const monthly = annualToMonthly(annual);
    items.push({
      leakType: 'recurring_fee',
      identityKey,
      title: `${group.merchant} is a recurring fee`,
      description: `Looks like a recurring fee charging ${group.avgAmount.toFixed(2)} ${group.currency} ${group.cadence}. Check whether it's avoidable.`,
      currency: group.currency,
      monthlyImpact: monthly,
      annualImpact: annual,
      severity: severityFor(annual),
      meta: {
        merchant: group.merchant,
        category: group.category,
        cadence: group.cadence,
        occurrences: group.occurrences,
      },
    });
    pushTotal(totals, group.currency, monthly, annual);
  }

  // 5. delivery_fee_high
  for (const bucket of input.deliverySpend) {
    if (!inCurrencyFilter(bucket.currency)) continue;
    if (bucket.total90d < DELIVERY_FEE_QUARTERLY_MIN) continue;
    const identityKey = `${bucket.currency}|delivery`;
    if (input.dismissals.has(dismissedKey('delivery_fee_high', identityKey))) {
      continue;
    }
    // 90d total * 4 ≈ annualized; not exact but communicates the order of
    // magnitude correctly to the user.
    const annual = bucket.total90d * 4;
    const monthly = annualToMonthly(annual);
    items.push({
      leakType: 'delivery_fee_high',
      identityKey,
      // total90d/transactionCount are whole delivery-ORDER totals (the route
      // sums each matched order, not a separate fee line), so the copy
      // describes delivery spend, not a "fee" — calling it a fee overstated
      // what the number measures.
      title: `Delivery spending adding up in ${bucket.currency}`,
      description: `${bucket.transactionCount} delivery orders in the last 90 days totalling ${bucket.total90d.toFixed(2)} ${bucket.currency} (~${annual.toFixed(0)}/year).`,
      currency: bucket.currency,
      monthlyImpact: monthly,
      annualImpact: annual,
      severity: severityFor(annual),
      meta: {
        total90d: bucket.total90d,
        transactionCount: bucket.transactionCount,
      },
    });
    pushTotal(totals, bucket.currency, monthly, annual);
  }

  items.sort((a, b) => b.annualImpact - a.annualImpact);

  return {
    items,
    totals: {
      byCurrency: Array.from(totals.values()).sort((a, b) =>
        a.currency.localeCompare(b.currency),
      ),
    },
  };
}
