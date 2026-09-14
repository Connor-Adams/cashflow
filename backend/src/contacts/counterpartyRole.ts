/**
 * People-ledger role vocabulary. Answers "what does this transfer mean between
 * me and this person", which is a different question from
 * `transactions.transfer_purpose` (issue #222), which answers "what role does
 * this movement play between my own accounts". The two must not share a column:
 * rows exist that are both contact-linked and pair-linked.
 *
 * `loc_interest` is the one value that lives on a row with no counterparty — it
 * marks a line-of-credit interest charge as allocatable in phase 2.
 */
import { COUNTERPARTY_ROLES } from '@cashflow/shared';
import type { CounterpartyRole } from '@cashflow/shared';

// One definition, in the DTO contract, so the frontend's role <select> and this
// validator can never drift apart. Re-exported here because every backend call
// site already imports the vocabulary from this module.
export { COUNTERPARTY_ROLES };
export type { CounterpartyRole };

const ROLE_SET: ReadonlySet<string> = new Set(COUNTERPARTY_ROLES);

export function isCounterpartyRole(v: unknown): v is CounterpartyRole {
  return typeof v === 'string' && ROLE_SET.has(v);
}

/** How a row contributes to a contact's balance. */
export type LedgerEffect = 'loan' | 'repayment' | 'none';

export interface ResolvedLedgerRole {
  effect: LedgerEffect;
  /**
   * True when an explicit `loan`/`repayment` tag contradicts the transaction's
   * direction. The direction wins — a sign is harder to get wrong than a
   * dropdown — but the caller surfaces the conflict rather than swallowing it.
   */
  mismatch: boolean;
}

const NONE: ResolvedLedgerRole = { effect: 'none', mismatch: false };

/**
 * Resolve one row's balance effect. Explicit role wins, then the contact's
 * loanDefault, then nothing. Direction decides between loan and repayment in
 * every branch, so a mis-set dropdown cannot invert a balance.
 */
export function resolveLedgerRole(args: {
  role: string | null;
  amount: number;
  loanDefault: boolean;
}): ResolvedLedgerRole {
  const { role, amount, loanDefault } = args;
  if (!Number.isFinite(amount) || amount === 0) return NONE;
  const byDirection: LedgerEffect = amount < 0 ? 'loan' : 'repayment';

  if (role == null) {
    return loanDefault ? { effect: byDirection, mismatch: false } : NONE;
  }
  if (role !== 'loan' && role !== 'repayment') {
    // Every other role — including an unrecognised stored value — is inert.
    return NONE;
  }
  return { effect: byDirection, mismatch: role !== byDirection };
}
