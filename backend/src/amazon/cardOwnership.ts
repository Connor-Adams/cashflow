/**
 * Resolve which Cashflow account a card last-4 belongs to.
 *
 * `accounts.bank_account_number` is empty on every account, so `short_code` is
 * the sole card identifier — and it holds the last4 as a SUFFIX in three
 * incompatible formats: Amex writes 6 digits ('701001' -> 1001), RBC and Wise
 * write the bare 4 ('5234'), and Wealthsimple writes an opaque alphanumeric
 * account id ('HQ6LMLTK8CAD') that carries no card number at all.
 *
 * Two consumers:
 *   - the Amazon matcher, where this replaces a dead text-scrape of
 *     txn.notes/sourceReference (0 hits across 111 production transactions);
 *   - foreign-card exclusion, where 291 of 538 orders carry a last4 belonging
 *     to no account.
 *
 * Pure: takes plain objects, never model instances, so it is trivially testable.
 */
export type CardOwnership = 'known' | 'foreign' | 'unknown';

/** The card last-4 an account's short code encodes, or null when it encodes none. */
export function resolveAccountLast4(shortCode: string | null): string | null {
  if (shortCode == null) return null;
  const trimmed = shortCode.trim();
  if (!/^\d{4,}$/.test(trimmed)) return null;
  return trimmed.slice(-4);
}

/** last4 -> account ids. A last4 shared by two accounts maps to both. */
export function buildLast4Map(
  accounts: { id: number; shortCode: string | null }[],
): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const account of accounts) {
    const last4 = resolveAccountLast4(account.shortCode);
    if (last4 == null) continue;
    const ids = map.get(last4) ?? [];
    ids.push(account.id);
    map.set(last4, ids);
  }
  return map;
}

/**
 * `unknown` is deliberately NOT `foreign`: absence of a last4 is not evidence of
 * a foreign card. 135 of 538 production orders have no last4 and most are the
 * user's own, so they stay matchable and counted — just badged.
 */
export function classifyCardOwnership(
  paymentLast4: string | null,
  map: Map<string, number[]>,
): CardOwnership {
  if (paymentLast4 == null || paymentLast4 === '') return 'unknown';
  return map.has(paymentLast4) ? 'known' : 'foreign';
}
