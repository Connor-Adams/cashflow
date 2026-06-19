import { PlannedEvent } from '../models';

export type MaterializeCardPaymentInput = {
  accountId: number;
  accountName: string;
  userId: number;
  householdId: number;
  amount: number;        // must be > 0
  currency: string;
  expectedDate: string;  // ISO YYYY-MM-DD
};

/** Marker embedded in a planned event's notes to make the feed idempotent. */
export function cardPaymentTag(accountId: number): string {
  return `[cc-payment:${accountId}]`;
}

/**
 * Materialize (or replace) a single planned credit-card payment for a card.
 * Idempotent per card: destroys any prior `planned` `source=credit_card` event
 * for the account, then creates the new one. Posted (paid) events are preserved
 * as history. Shared by the HTTP route and the statement-import path.
 */
export async function materializeCreditCardPayment(
  input: MaterializeCardPaymentInput,
): Promise<InstanceType<typeof PlannedEvent>> {
  const { accountId, accountName, userId, householdId, amount, currency, expectedDate } = input;

  await PlannedEvent.destroy({
    where: { householdId, accountId, source: 'credit_card', status: 'planned' },
  });

  return PlannedEvent.create({
    userId,
    householdId,
    accountId,
    type: 'debt_payment',
    name: `${accountName} payment`,
    amount: amount.toFixed(4),
    currency,
    expectedDate,
    recurrenceRule: null,
    source: 'credit_card',
    status: 'planned',
    linkedTransactionId: null,
    notes: cardPaymentTag(accountId),
  });
}
