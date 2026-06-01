import type { PlannedEventStatus, SubscriptionCadence } from '../models/PlannedEvent';

/** Legacy Subscription status as exposed by /api/subscriptions. */
export type SubscriptionStatus = 'active' | 'cancelled' | 'ignored' | 'unknown';

/** Expectation status (+ uncertainty flag) -> legacy Subscription status. */
export function toSubscriptionStatus(
  status: PlannedEventStatus,
  statusUncertain: boolean,
): SubscriptionStatus {
  if (statusUncertain) return 'unknown';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'ignored') return 'ignored';
  return 'active';
}

/** Legacy Subscription status (write path) -> Expectation status + flag. */
export function fromSubscriptionStatus(
  status: SubscriptionStatus,
): { status: PlannedEventStatus; statusUncertain: boolean } {
  switch (status) {
    case 'cancelled': return { status: 'cancelled', statusUncertain: false };
    case 'ignored': return { status: 'ignored', statusUncertain: false };
    case 'unknown': return { status: 'planned', statusUncertain: true };
    case 'active': default: return { status: 'planned', statusUncertain: false };
  }
}

/** Serialize a merged Expectation row (kind='subscription') to the legacy DTO. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serializeSubscription(row: any) {
  return {
    id: row.id,
    householdId: row.householdId,
    merchantName: row.name,
    normalizedName: row.normalizedName,
    amount: String(row.amount),
    currency: row.currency,
    cadence: row.cadence as SubscriptionCadence,
    lastChargeDate: row.lastChargeDate,
    nextExpectedDate: row.nextExpectedDate,
    status: toSubscriptionStatus(row.status, row.statusUncertain),
    category: row.category,
    annualizedCost: String(row.annualizedCost),
    priceChangeDetected: row.priceChangeDetected,
    cancellationUrl: row.cancellationUrl,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
