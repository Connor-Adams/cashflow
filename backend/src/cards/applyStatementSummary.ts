import type { Account } from '../models';
import { LiabilityAccount } from '../models';
import type { PdfStatementHeader } from '../import/pdf/types';
import { materializeCreditCardPayment } from './materializePayment';
import { logger } from '../observability/logger';

type Opts = {
  account: InstanceType<typeof Account>;
  header: PdfStatementHeader;
  userId: number;
  householdId: number;
};

/**
 * On credit-card statement import: persist the parsed summary fields onto the
 * card's LiabilityAccount sidecar (import is source of truth), then auto-place a
 * calendar payment for the statement balance on the parsed due date.
 *
 * Guards:
 *  - non-credit_card accounts: no-op.
 *  - strictly-older statement than the stored statementDate: no-op (newer-wins).
 *  - missing statement balance OR due date: persist what parsed, but DO NOT
 *    auto-place an event (never trust a partial parse to write money to the
 *    calendar).
 */
export async function applyCreditCardStatementSummary(opts: Opts): Promise<void> {
  const { account, header, userId, householdId } = opts;
  if (header.accountType !== 'credit_card') return;

  const statementBalance = header.statementBalance ?? null;
  const minimumPayment = header.minimumPayment ?? null;
  const paymentDueDate = header.paymentDueDate ?? null;
  // The statement cycle date used for both storage and staleness ordering.
  const incomingStatementDate = header.periodEnd;

  const existing = await LiabilityAccount.findOne({ where: { accountId: account.id } });

  // Staleness guard: a strictly-older statement must not clobber the current bill.
  if (existing?.statementDate && incomingStatementDate < existing.statementDate) {
    logger.info(
      { accountId: account.id, incomingStatementDate, stored: existing.statementDate },
      'cc-statement: skipping older statement (newer-wins)',
    );
    return;
  }

  const dueDay = paymentDueDate ? Number(paymentDueDate.slice(8, 10)) : null;

  // Upsert only the fields that parsed (non-null), never wiping existing values.
  const updates: Partial<{
    statementBalance: string; minimumPayment: string; dueDay: number; statementDate: string;
  }> = { statementDate: incomingStatementDate };
  if (statementBalance != null) updates.statementBalance = statementBalance.toFixed(4);
  if (minimumPayment != null) updates.minimumPayment = minimumPayment.toFixed(4);
  if (dueDay != null) updates.dueDay = dueDay;

  if (existing) {
    await existing.update(updates);
  } else {
    await LiabilityAccount.create({ accountId: account.id, householdId, ...updates });
  }

  // Auto-place guard: both balance AND due date must be clean to write the event.
  if (statementBalance != null && statementBalance > 0 && paymentDueDate != null) {
    await materializeCreditCardPayment({
      accountId: account.id,
      accountName: account.name,
      userId,
      householdId,
      amount: statementBalance,
      currency: account.defaultCurrency ?? 'CAD',
      expectedDate: paymentDueDate,
    });
  } else {
    logger.info(
      { accountId: account.id, hasBalance: statementBalance != null, hasDueDate: paymentDueDate != null },
      'cc-statement: fields persisted but auto-place skipped (incomplete parse)',
    );
  }
}
